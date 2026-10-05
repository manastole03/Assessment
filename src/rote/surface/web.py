"""Playwright-backed web surface.

Design choices that matter for legacy back-office apps:

* Perception runs *inside* every frame (``perception.js`` via an init script), so framesets and
  nested frames are first-class; each target records which frame it lives in.
* Every DOM call has a timeout and is skipped while a native dialog is open — an ``alert()`` blocks
  the page's JS thread, and a naive automation would hang instead of noticing the dialog.
* Actions race against dialogs: if a click opens a ``confirm()``, the click is considered done and
  the dialog becomes observable state for handlers to deal with.
* The network allowlist is enforced by request interception, independent of what the agent chose.
* Screenshots are masked (sensitive text blanked in the DOM) before capture.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit

from playwright.async_api import (
    Browser,
    BrowserContext,
    Dialog,
    ElementHandle,
    Frame,
    Page,
    Playwright,
    Route,
)
from playwright.async_api import (
    Error as PlaywrightError,
)
from playwright.async_api import (
    Request as PWRequest,
)

from ..artifact.schema import (
    Condition,
    DialogCondition,
    ElementCondition,
    FrameRef,
    Locator,
    OutputCondition,
    Target,
    TextCondition,
    UrlCondition,
)
from ..artifact.templates import TemplateContext
from ..handoff.control import Actor, LeaseState, SessionControl
from ..policy.policy import PolicyEngine
from ..policy.redaction import SCREEN_PATTERNS, Redactor
from .base import (
    DialogInfo,
    ElementInfo,
    FrameInfo,
    LocatorCheck,
    Observation,
    Resolved,
    Unresolved,
)

PERCEPTION_JS = (Path(__file__).parent / "perception.js").read_text()
VIEWPORT = {"width": 1280, "height": 800}
EVAL_TIMEOUT_S = 3.0


class DialogBlocked(RuntimeError):
    """A native dialog is open; the page cannot be inspected or driven until it is answered."""


class ActionFailed(RuntimeError):
    pass


def render_locator(locator: Locator, ctx: TemplateContext) -> dict[str, Any]:
    data = locator.model_dump(exclude_none=True)
    return {k: ctx.render(v) if isinstance(v, str) else v for k, v in data.items()}


class WebSurface:
    kind = "web"

    def __init__(
        self,
        *,
        browser: Browser,
        context: BrowserContext,
        base_url: str,
        control: SessionControl,
        policy: PolicyEngine,
        redactor: Redactor,
        volatile_params: list[str],
        on_event: Callable[[str, dict[str, Any]], object],
    ):
        self.browser = browser
        self.context = context
        self.page: Page = None  # type: ignore[assignment]  # set by launch()
        self.base_url = base_url.rstrip("/")
        self.control = control
        self.policy = policy
        self.redactor = redactor
        self.volatile_params = volatile_params
        self.on_event = on_event
        self.human_listener: Callable[[dict[str, Any], str | None], None] | None = None
        self.blocked_requests: list[str] = []
        self._dialog: Dialog | None = None
        self._dialog_seen = asyncio.Event()
        self._acting = 0
        self._ref_frames: dict[str, Frame] = {}
        self._pending_documents: set[PWRequest] = set()
        self._screenshot_lock = asyncio.Lock()

    # ================================================================================ lifecycle

    @classmethod
    async def launch(
        cls,
        playwright: Playwright,
        *,
        headless: bool,
        base_url: str,
        control: SessionControl,
        policy: PolicyEngine,
        redactor: Redactor,
        volatile_params: list[str],
        on_event: Callable[[str, dict[str, Any]], object],
        slow_mo_ms: int = 0,
    ) -> WebSurface:
        browser = await playwright.chromium.launch(headless=headless, slow_mo=slow_mo_ms)
        context = await browser.new_context(viewport=VIEWPORT)  # type: ignore[arg-type]
        surface = cls(
            browser=browser,
            context=context,
            base_url=base_url,
            control=control,
            policy=policy,
            redactor=redactor,
            volatile_params=volatile_params,
            on_event=on_event,
        )
        await context.add_init_script(PERCEPTION_JS)
        await context.expose_binding("__roteHumanEvent", surface._on_human_event)
        await context.route("**/*", surface._route)
        surface.page = await context.new_page()
        surface.page.on("dialog", surface._on_dialog)
        surface.page.on("request", surface._on_request)
        surface.page.on("requestfinished", surface._on_request_done)
        surface.page.on("requestfailed", surface._on_request_done)
        return surface

    def _on_request(self, request: PWRequest) -> None:
        if request.resource_type == "document":
            self._pending_documents.add(request)

    def _on_request_done(self, request: PWRequest) -> None:
        self._pending_documents.discard(request)

    def navigation_pending(self) -> bool:
        """True while any frame is still loading a document (e.g. a slow server response)."""
        return bool(self._pending_documents)

    async def close(self) -> None:
        with contextlib.suppress(PlaywrightError):
            await self.context.close()
        with contextlib.suppress(PlaywrightError):
            await self.browser.close()

    # ================================================================================ guards

    async def _route(self, route: Route, request: PWRequest) -> None:
        if self.policy.url_allowed(request.url):
            await route.continue_()
            return
        self.blocked_requests.append(request.url)
        self.on_event("policy.network_blocked", {"url": request.url, "resource": request.resource_type})
        await route.abort("blockedbyclient")

    def _on_dialog(self, dialog: Dialog) -> None:
        self._dialog = dialog
        self._dialog_seen.set()
        self.on_event("surface.dialog_opened", {"kind": dialog.type, "message": dialog.message})

    async def _on_human_event(self, source: dict[str, Any], payload: dict[str, Any]) -> None:
        frame: Frame | None = source.get("frame")
        frame_name = self.frame_name(frame) if frame else None
        if self.control.state is LeaseState.HUMAN:
            if self.human_listener:
                self.human_listener(payload, frame_name)
        elif self._acting == 0:
            self.on_event(
                "control.unsolicited_input",
                {
                    "kind": payload.get("kind"),
                    "frame": frame_name,
                    "lease": self.control.state.value,
                    "element": (payload.get("element") or {}).get("name"),
                },
            )

    # ================================================================================ frames & urls

    def relative(self, url: str) -> tuple[str, dict[str, str]]:
        parts = urlsplit(url)
        base_path = urlsplit(self.base_url).path.rstrip("/")
        path = parts.path
        if path.startswith(base_path + "/"):
            path = path[len(base_path) + 1 :]
        return path, dict(parse_qsl(parts.query))

    def frame_name(self, frame: Frame | None) -> str | None:
        if frame is None or frame == self.page.main_frame:
            return None
        return frame.name or self.relative(frame.url)[0]

    def _live_frames(self) -> list[Frame]:
        return [f for f in self.page.frames if not f.is_detached()]

    def find_frame(self, ref: FrameRef | str | None) -> Frame | None:
        if ref is None:
            return self.page.main_frame
        name, path = (ref, None) if isinstance(ref, str) else (ref.name, ref.path)
        for frame in self._live_frames():
            if name is not None and frame != self.page.main_frame and frame.name == name:
                return frame
        for frame in self._live_frames():
            if frame != self.page.main_frame and (self.relative(frame.url)[0] in (name, path)):
                return frame
        return None

    async def _frame_offset(self, frame: Frame) -> tuple[float, float]:
        if frame == self.page.main_frame:
            return 0.0, 0.0
        with contextlib.suppress(PlaywrightError, TimeoutError):
            element = await asyncio.wait_for(frame.frame_element(), EVAL_TIMEOUT_S)
            box = await asyncio.wait_for(element.bounding_box(), EVAL_TIMEOUT_S)
            if box:
                return box["x"], box["y"]
        return 0.0, 0.0

    async def _eval(self, frame: Frame, script: str, arg: Any = None) -> Any:
        if self._dialog is not None:
            raise DialogBlocked(self._dialog.message)
        try:
            return await asyncio.wait_for(frame.evaluate(script, arg), EVAL_TIMEOUT_S)
        except TimeoutError as exc:
            if self._dialog is not None:
                raise DialogBlocked(self._dialog.message) from exc
            raise

    # ================================================================================ perception

    def dialog(self) -> DialogInfo | None:
        return DialogInfo(self._dialog.type, self._dialog.message) if self._dialog else None

    async def observe(self, *, screenshot: bool = True) -> Observation:
        dialog = self.dialog()
        frames: list[FrameInfo] = []
        elements: list[ElementInfo] = []
        self._ref_frames = {}
        if dialog is None:
            offset = 0
            for frame in self._live_frames():
                name = self.frame_name(frame)
                path = self.relative(frame.url)[0]
                try:
                    snap = await self._eval(frame, "(o) => window.__rote ? window.__rote.snapshot(o) : null", offset)
                except (DialogBlocked, PlaywrightError, TimeoutError):
                    continue
                frames.append(FrameInfo(name=name, url=frame.url, path=path))
                if not snap:
                    continue
                origin = await self._frame_offset(frame)
                for item in snap["items"]:
                    element = ElementInfo.from_js(item, name, origin)
                    elements.append(element)
                    if element.ref:
                        self._ref_frames[element.ref] = frame
                offset += snap["count"]
        shot = await self.screenshot() if screenshot and dialog is None else None
        title = ""
        with contextlib.suppress(PlaywrightError, TimeoutError):
            title = await asyncio.wait_for(self.page.title(), EVAL_TIMEOUT_S) if dialog is None else ""
        return Observation(
            url=self.page.url, title=title, frames=frames, elements=elements, dialog=dialog, screenshot=shot
        )

    async def screenshot(self, *, mask: bool = True) -> bytes | None:
        # Serialised: a concurrent viewer's unmask must never land between an evidence capture's
        # mask and its screenshot, or the persisted image would show unmasked data.
        async with self._screenshot_lock:
            return await self._screenshot(mask=mask)

    async def _screenshot(self, *, mask: bool) -> bytes | None:
        if self._dialog is not None:
            return None
        frames = self._live_frames()
        try:
            if mask:
                # JS regexes take flags separately; drop Python's inline (?i) (mask() is case-insensitive).
                arg = [
                    self.redactor.known_values(),
                    SCREEN_PATTERNS,
                    [p.pattern.replace("(?i)", "") for p in self.redactor.sensitive_label_patterns],
                ]
                for frame in frames:
                    with contextlib.suppress(DialogBlocked, PlaywrightError, TimeoutError):
                        await self._eval(frame, "(a) => window.__rote && window.__rote.mask(a[0], a[1], a[2])", arg)
            return await asyncio.wait_for(self.page.screenshot(type="jpeg", quality=70), 10)
        except (PlaywrightError, TimeoutError):
            return None
        finally:
            if mask:
                for frame in frames:
                    with contextlib.suppress(DialogBlocked, PlaywrightError, TimeoutError):
                        await self._eval(frame, "() => window.__rote && window.__rote.unmask()")

    async def dom_snapshot(self) -> dict[str, str]:
        out: dict[str, str] = {}
        if self._dialog is not None:
            return out
        for index, frame in enumerate(self._live_frames()):
            with contextlib.suppress(PlaywrightError, TimeoutError):
                html = await asyncio.wait_for(frame.content(), EVAL_TIMEOUT_S)
                out[f"{index:02d}_{self.frame_name(frame) or 'top'}"] = self.redactor.text(html)
        return out

    async def frame_texts(self, *, raw: bool = False) -> dict[str | None, str]:
        """Visible text per frame — one DOM call per frame, shared by every condition in a poll.
        Normalised (collapsed whitespace, lower case) unless ``raw``."""
        out: dict[str | None, str] = {}
        if self._dialog is not None:
            return out
        for frame in self._live_frames():
            with contextlib.suppress(DialogBlocked, PlaywrightError, TimeoutError):
                text = await self._eval(frame, "() => window.__rote ? window.__rote.visibleText() : ''") or ""
                name = self.frame_name(frame)
                if text or name is None:
                    out[name] = text if raw else " ".join(text.split()).lower()
        return out

    # ================================================================================ targeting

    async def resolve(self, target: Target, ctx: TemplateContext) -> Resolved | Unresolved:
        home = self.find_frame(target.frame) if target.frame else self.page.main_frame
        frames = [home] if home else []
        result = await self._resolve_in(frames, target, ctx) if frames else None
        if isinstance(result, Resolved):
            return result
        others = [f for f in self._live_frames() if f not in frames]
        fallback = await self._resolve_in(others, target, ctx)
        if isinstance(fallback, Resolved):
            expected = target.frame.name or target.frame.path if target.frame else "top"
            fallback.warnings.append(f"frame drift: found in '{fallback.frame or 'top'}', recorded in '{expected}'")
            return fallback
        if result is None:
            return Unresolved(
                "frame_missing",
                fallback.checks if isinstance(fallback, Unresolved) else [],
                f"frame {target.frame} is not present",
            )
        return result

    async def _resolve_in(self, frames: list[Frame], target: Target, ctx: TemplateContext) -> Resolved | Unresolved:
        hits: list[list[tuple[Frame, str]]] = []
        checks: list[LocatorCheck] = []
        for index, locator in enumerate(target.locators):
            found: list[tuple[Frame, str]] = []
            rendered = render_locator(locator, ctx)
            for frame in frames:
                with contextlib.suppress(PlaywrightError, TimeoutError):
                    refs = await self._eval(frame, "(l) => window.__rote ? window.__rote.resolveRefs(l) : []", rendered)
                    found.extend((frame, ref) for ref in refs or [])
            hits.append(found)
            checks.append(
                LocatorCheck(
                    index=index,
                    strategy=locator.by,
                    count=len(found),
                    verdict="missing" if not found else "ambiguous" if len(found) > 1 else "unique",
                )
            )
        chosen: int | None = None
        info: ElementInfo | None = None
        for index, found in enumerate(hits):
            if len(found) != 1:
                continue
            frame, ref = found[0]
            described = await self._describe(frame, ref)
            if described is None:
                continue
            if target.role and described.role != target.role:
                checks[index].verdict = "role_mismatch"
                continue
            chosen, info = index, described
            break
        if chosen is None or info is None:
            reason = "ambiguous" if any(c.count > 1 for c in checks) else "not_found"
            return Unresolved(reason, checks, "; ".join(f"{c.strategy}: {c.count} match(es)" for c in checks))
        frame, ref = hits[chosen][0]
        for index, check in enumerate(checks):
            if index == chosen:
                check.verdict = "chosen"
            elif check.count == 1 and check.verdict != "role_mismatch":
                check.verdict = "agree" if hits[index][0] == (frame, ref) else "conflict"
        self._ref_frames[ref] = frame
        return Resolved(frame=self.frame_name(frame), ref=ref, element=info, strategy_index=chosen, checks=checks)

    async def _describe(self, frame: Frame, ref: str) -> ElementInfo | None:
        with contextlib.suppress(PlaywrightError, TimeoutError, DialogBlocked):
            data = await self._eval(frame, "(r) => window.__rote.describeRef(r)", ref)
            if data:
                return ElementInfo.from_js(
                    {**data, "ref": ref}, self.frame_name(frame), await self._frame_offset(frame)
                )
        return None

    async def by_ref(self, ref: str) -> Resolved | None:
        """An element from the latest observation (discovery acts on refs, then records locators)."""
        frame = self._ref_frames.get(ref)
        if frame is None or frame.is_detached():
            return None
        info = await self._describe(frame, ref)
        if info is None:
            return None
        return Resolved(
            frame=self.frame_name(frame),
            ref=ref,
            element=info,
            strategy_index=0,
            checks=[LocatorCheck(0, "ref", 1, "chosen")],
        )

    async def element_at(self, x: float, y: float) -> Resolved | None:
        """Hit-test page coordinates (screenshot space) down to an element in the right frame."""
        for frame in reversed(self._live_frames()):
            ox, oy = await self._frame_offset(frame)
            if frame != self.page.main_frame:
                with contextlib.suppress(PlaywrightError, TimeoutError):
                    box = await (await frame.frame_element()).bounding_box()
                    if not box or not (
                        box["x"] <= x < box["x"] + box["width"] and box["y"] <= y < box["y"] + box["height"]
                    ):
                        continue
            with contextlib.suppress(PlaywrightError, TimeoutError, DialogBlocked):
                hit = await self._eval(
                    frame, "(p) => window.__rote && window.__rote.elementAt(p[0], p[1])", [x - ox, y - oy]
                )
                if hit:
                    self._ref_frames[hit["ref"]] = frame
                    return await self.by_ref(hit["ref"])
        return None

    async def synthesize(self, resolved: Resolved, *, prefer_values: list[str]) -> list[dict[str, Any]]:
        frame = self._ref_frames.get(resolved.ref)
        if frame is None:
            return []
        with contextlib.suppress(PlaywrightError, TimeoutError, DialogBlocked):
            return (
                await self._eval(
                    frame,
                    "(a) => window.__rote.synthesizeRef(a[0], a[1])",
                    [resolved.ref, {"volatileParams": self.volatile_params, "preferValues": prefer_values}],
                )
                or []
            )
        return []

    async def _handle(self, resolved: Resolved) -> ElementHandle:
        frame = self._ref_frames.get(resolved.ref)
        if frame is None or frame.is_detached():
            raise ActionFailed(f"element {resolved.ref} is no longer attached")
        try:
            handle = await frame.evaluate_handle("(r) => window.__rote.byRef(r)", resolved.ref)
        except PlaywrightError as exc:
            raise ActionFailed(f"element {resolved.ref} is no longer attached: {exc}") from exc
        element = handle.as_element()
        if element is None:
            raise ActionFailed(f"element {resolved.ref} is no longer attached")
        return element

    # ================================================================================ conditions

    async def check(self, condition: Condition, ctx: TemplateContext) -> bool:
        if isinstance(condition, DialogCondition):
            return self._dialog is not None and condition.text.lower() in self._dialog.message.lower()
        if isinstance(condition, UrlCondition):
            frame = self.find_frame(condition.frame) if condition.frame else self.page.main_frame
            if frame is None:
                return False
            path, query = self.relative(frame.url)
            if path.lower() != ctx.render(condition.path).lower():
                return False
            return all(query.get(k) == ctx.render(v) for k, v in condition.query.items())
        if self._dialog is not None:
            return False
        if isinstance(condition, TextCondition):
            frames = [self.find_frame(condition.frame)] if condition.frame else self._live_frames()
            needle = ctx.render(condition.text)
            for frame in frames:
                if frame is None:
                    continue
                with contextlib.suppress(DialogBlocked, PlaywrightError, TimeoutError):
                    if await self._eval(
                        frame,
                        "(a) => window.__rote ? window.__rote.hasText(a[0], a[1]) : false",
                        [needle, condition.regex],
                    ):
                        return True
            return False
        if isinstance(condition, ElementCondition):
            return isinstance(await self.resolve(condition.target, ctx), Resolved)
        if isinstance(condition, OutputCondition):
            raise TypeError("output conditions are evaluated by the engine, not the surface")
        return False

    # ================================================================================ actions

    async def _perform(self, actor: Actor, action: Callable[[], Awaitable[Any]], timeout_s: float = 20) -> None:
        self.control.ensure(actor)
        if self._dialog is not None:
            raise DialogBlocked(self._dialog.message)
        self._acting += 1
        try:
            task = asyncio.ensure_future(action())
            dialog_wait = asyncio.ensure_future(self._dialog_seen.wait())
            done, _ = await asyncio.wait({task, dialog_wait}, timeout=timeout_s, return_when=asyncio.FIRST_COMPLETED)
            dialog_wait.cancel()
            if task in done:
                try:
                    task.result()
                except PlaywrightError as exc:
                    raise ActionFailed(str(exc).splitlines()[0]) from exc
                return
            if self._dialog is not None:  # the action opened a native dialog; it becomes observable state
                task.add_done_callback(lambda t: t.cancelled() or t.exception())
                return
            task.cancel()
            raise ActionFailed(f"action did not complete within {timeout_s:.0f}s")
        finally:
            await asyncio.sleep(0.05)
            self._acting -= 1

    async def navigate(self, url: str, *, actor: Actor) -> None:
        decision = self.policy.check_url(url)
        if not decision.allowed:
            raise PermissionError(decision.reason)
        await self._perform(actor, lambda: self.page.goto(url, wait_until="commit"))

    async def click(self, resolved: Resolved, *, actor: Actor) -> None:
        handle = await self._handle(resolved)
        await self._perform(actor, lambda: handle.click(timeout=10_000))

    async def fill(self, resolved: Resolved, value: str, *, actor: Actor) -> None:
        handle = await self._handle(resolved)
        await self._perform(actor, lambda: handle.fill(value, timeout=10_000))

    async def select(self, resolved: Resolved, option: str, *, actor: Actor) -> None:
        handle = await self._handle(resolved)

        async def choose() -> None:
            try:
                await handle.select_option(label=option, timeout=5_000)
            except PlaywrightError:
                options = resolved.element.options or []
                match = next((o for o in options if option.lower() in o.lower()), None)
                if match is None:
                    raise
                await handle.select_option(label=match, timeout=5_000)

        await self._perform(actor, choose)

    async def press(self, key: str, resolved: Resolved | None, *, actor: Actor) -> None:
        if resolved is None:
            await self._perform(actor, lambda: self.page.keyboard.press(key))
            return
        handle = await self._handle(resolved)
        await self._perform(actor, lambda: handle.press(key, timeout=10_000))

    async def read(self, resolved: Resolved) -> str:
        frame = self._ref_frames.get(resolved.ref)
        info = await self._describe(frame, resolved.ref) if frame is not None else None
        if info is None:
            raise ActionFailed(f"element {resolved.ref} disappeared before it could be read")
        if info.value is not None and info.role in ("textbox", "combobox", "listbox"):
            return info.value
        return info.text or info.name

    async def reload(self, frame_ref: str | None, *, actor: Actor) -> None:
        frame = self.find_frame(frame_ref) if frame_ref else None
        if frame is None or frame == self.page.main_frame:
            await self._perform(actor, lambda: self.page.reload(wait_until="commit"))
        else:
            url = frame.url
            await self._perform(actor, lambda: frame.goto(url, wait_until="commit"))

    async def answer_dialog(self, accept: bool, *, actor: Actor) -> None:
        self.control.ensure(actor)
        dialog, self._dialog = self._dialog, None
        self._dialog_seen.clear()
        if dialog is None:
            return
        self.on_event("surface.dialog_answered", {"accept": accept, "message": dialog.message, "by": actor.kind.value})
        with contextlib.suppress(PlaywrightError):
            await (dialog.accept() if accept else dialog.dismiss())

    # ================================================================================ operator input
    # Raw input forwarded from the operator console. The lease check makes these fail for anyone
    # but the current human holder; the DOM listeners record what the operator actually did.

    async def human_click(self, x: float, y: float, *, actor: Actor) -> None:
        self.control.ensure(actor)
        await self.page.mouse.click(x, y)

    async def human_type(self, text: str, *, actor: Actor) -> None:
        self.control.ensure(actor)
        await self.page.keyboard.type(text, delay=20)

    async def human_press(self, key: str, *, actor: Actor) -> None:
        self.control.ensure(actor)
        await self.page.keyboard.press(key)
