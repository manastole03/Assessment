"""FastAPI server for the LegacyCore mock. Routes deliberately mimic a classic-ASP back office."""

from __future__ import annotations

import asyncio
import secrets
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response
from fastapi.templating import Jinja2Templates

from .data import MEMBERS, find_members, money
from .faults import FAULT_STATE, Faults, faults_for
from .tenants import TENANTS, Tenant

HERE = Path(__file__).parent
templates = Jinja2Templates(directory=str(HERE / "templates"))
app = FastAPI(title="LegacyCore Member Services (mock)", docs_url="/__admin/docs", redoc_url=None)


@dataclass
class Session:
    token: str
    tenant: str
    user: str
    expired: bool = False
    attested: bool = False


@dataclass
class Ledger:
    posted: list[dict[str, Any]] = field(default_factory=list)


SESSIONS: dict[str, Session] = {}
LEDGERS: dict[str, Ledger] = {}
SHARE_TYPES = [("01", "XMAS_CLUB"), ("02", "VACATION CLUB"), ("05", "MONEY MARKET"), ("09", "IRA SAVINGS")]


# --------------------------------------------------------------------------------------------- helpers


def _tenant(tenant_id: str) -> Tenant:
    tenant = TENANTS.get(tenant_id)
    if tenant is None:
        raise HTTPException(404, "UNKNOWN INSTITUTION")
    return tenant


def _cookie(tenant: Tenant) -> str:
    return f"LCSESS_{tenant.id.upper()}"


def _session(request: Request, tenant: Tenant) -> Session | None:
    token = request.cookies.get(_cookie(tenant))
    return SESSIONS.get(token) if token else None


def _page(request: Request, name: str, tenant: Tenant, status: int = 200, **ctx: Any) -> HTMLResponse:
    response = templates.TemplateResponse(request, name, {"t": tenant, **ctx}, status_code=status)
    response.headers["Cache-Control"] = "no-store"
    return response


def _message(
    request: Request,
    tenant: Tenant,
    title: str,
    message: str,
    *,
    error: bool = False,
    link: dict[str, str] | None = None,
    status: int = 200,
) -> HTMLResponse:
    return _page(request, "message.html", tenant, status=status, title=title, message=message, error=error, link=link)


def _expired(request: Request, tenant: Tenant) -> HTMLResponse:
    return _message(
        request,
        tenant,
        "SESSION",
        "YOUR SESSION HAS EXPIRED. PLEASE SIGN ON AGAIN.",
        error=True,
        link={"href": "signon.asp", "target": "_top", "text": "Sign On"},
    )


def _here(request: Request) -> str:
    return request.url.path.rsplit("/", 1)[-1] + (f"?{request.url.query}" if request.url.query else "")


def _share_view(tenant: Tenant, member_number: str) -> list[dict[str, str]]:
    member = MEMBERS[member_number]
    return [
        {
            "suffix": s.suffix,
            "description": tenant.products.get(s.product, s.product),
            "balance": money(s.balance),
            "available": money(s.available),
            "status": s.status,
        }
        for s in member.shares
    ]


@dataclass
class Guarded:
    session: Session
    confirm_dialog: bool = False


async def _guard(request: Request, tenant: Tenant) -> Guarded | Response:
    """Everything a main-frame page must pass through: auth, then injected runtime faults."""
    session = _session(request, tenant)
    if session is None or session.expired:
        return _expired(request, tenant)
    faults = faults_for(tenant.id)
    if faults.session_expire_after is not None:
        faults.session_expire_after -= 1
        if faults.session_expire_after < 0:
            faults.session_expire_after = None
            session.expired = True
            return _expired(request, tenant)
    if faults.transient_errors > 0:
        faults.transient_errors -= 1
        return _message(
            request,
            tenant,
            "SERVICE TEMPORARILY UNAVAILABLE",
            "THE SERVER IS BUSY. PLEASE RETRY YOUR REQUEST. (ERR 80004005)",
            error=True,
            link={"href": _here(request), "text": "Retry"},
            status=503,
        )
    if faults.slow_ms:
        await asyncio.sleep(faults.slow_ms / 1000)
    if request.method == "GET":
        if faults.maintenance_notice:
            faults.maintenance_notice = False
            return _page(
                request,
                "interstitial.html",
                tenant,
                title="SYSTEM NOTICE",
                message="LEGACYCORE WILL BE UNAVAILABLE SATURDAY 02:00-04:00 ET FOR SCHEDULED MAINTENANCE.",
                button="Acknowledge",
                onclick=f"location.href='{_here(request)}'",
            )
        if faults.compliance_popup and not session.attested:  # blocks every page until this session attests
            return _page(
                request,
                "interstitial.html",
                tenant,
                title="ANNUAL COMPLIANCE ATTESTATION",
                message="BEFORE CONTINUING YOU MUST CONFIRM COMPLETION OF ANNUAL BSA/AML TRAINING.",
                checkbox="I confirm I have completed the annual BSA/AML training",
                button="Continue",
                onclick=f"location.href='attest.asp?next={quote(_here(request))}'",
            )
    confirm = faults.session_warning_dialog
    faults.session_warning_dialog = False
    return Guarded(session=session, confirm_dialog=confirm)


# --------------------------------------------------------------------------------------------- pages


@app.get("/", response_class=HTMLResponse)
async def index() -> str:
    links = "".join(f'<li><a href="/{t.id}/">{t.name}</a> (LegacyCore v{t.version})</li>' for t in TENANTS.values())
    return f"<html><body><h3>LegacyCore mock - institutions</h3><ul>{links}</ul></body></html>"


@app.get("/{tenant_id}/lc.css")
async def css(tenant_id: str) -> FileResponse:
    _tenant(tenant_id)
    return FileResponse(HERE / "static" / "lc.css", media_type="text/css")


@app.get("/{tenant_id}/")
@app.get("/{tenant_id}/default.asp")
async def frameset(request: Request, tenant_id: str) -> Response:
    tenant = _tenant(tenant_id)
    session = _session(request, tenant)
    if session is None or session.expired:
        return RedirectResponse(f"/{tenant.id}/signon.asp", status_code=302)
    return _page(request, "frameset.html", tenant)


@app.get("/{tenant_id}/signon.asp")
async def signon_form(request: Request, tenant_id: str) -> Response:
    return _page(request, "signon.html", _tenant(tenant_id))


@app.post("/{tenant_id}/signon.asp")
async def signon(request: Request, tenant_id: str) -> Response:
    tenant = _tenant(tenant_id)
    form = await request.form()
    user = str(form.get("USRID", "")).strip().upper()
    password = str(form.get("PSWD", ""))
    if tenant.users.get(user) != password:
        return _page(request, "signon.html", tenant, error="INVALID USER ID OR PASSWORD")
    token = secrets.token_hex(12)
    SESSIONS[token] = Session(token=token, tenant=tenant.id, user=user)
    target = "notice.asp" if tenant.security_notice else "default.asp"
    response = RedirectResponse(f"/{tenant.id}/{target}", status_code=302)
    response.set_cookie(_cookie(tenant), token, path=f"/{tenant.id}/", httponly=True)
    return response


@app.get("/{tenant_id}/notice.asp")
async def security_notice(request: Request, tenant_id: str) -> Response:
    """Vendor feature some tenants enable: a daily notice shown after sign-on."""
    tenant = _tenant(tenant_id)
    if _session(request, tenant) is None:
        return RedirectResponse(f"/{tenant.id}/signon.asp", status_code=302)
    return _page(
        request,
        "interstitial.html",
        tenant,
        title="DAILY SECURITY NOTICE",
        message="NEVER SHARE YOUR CREDENTIALS. REPORT SUSPICIOUS ACTIVITY TO THE INFORMATION SECURITY OFFICER.",
        button="Continue",
        onclick="location.href='default.asp'",
    )


@app.get("/{tenant_id}/attest.asp")
async def attest(request: Request, tenant_id: str, next: str = "welcome.asp") -> Response:
    tenant = _tenant(tenant_id)
    session = _session(request, tenant)
    if session is not None:
        session.attested = True
    safe_next = next if not next.startswith(("http:", "https:", "/", "javascript:")) else "welcome.asp"
    return RedirectResponse(f"/{tenant.id}/{safe_next}", status_code=302)


@app.get("/{tenant_id}/signoff.asp")
async def signoff(request: Request, tenant_id: str) -> Response:
    tenant = _tenant(tenant_id)
    session = _session(request, tenant)
    if session is not None:
        SESSIONS.pop(session.token, None)
    return _message(
        request,
        tenant,
        "SIGN OFF",
        "YOU HAVE BEEN SIGNED OFF.",
        link={"href": "signon.asp", "target": "_top", "text": "Sign On"},
    )


@app.get("/{tenant_id}/banner.asp")
async def banner(request: Request, tenant_id: str) -> Response:
    tenant = _tenant(tenant_id)
    session = _session(request, tenant)
    return _page(request, "banner.html", tenant, user=session.user if session else "-")


@app.get("/{tenant_id}/menu.asp")
async def menu(request: Request, tenant_id: str) -> Response:
    return _page(request, "menu.html", _tenant(tenant_id))


@app.get("/{tenant_id}/welcome.asp")
async def welcome(request: Request, tenant_id: str) -> Response:
    tenant = _tenant(tenant_id)
    guard = await _guard(request, tenant)
    if isinstance(guard, Response):
        return guard
    return _page(request, "welcome.html", tenant, confirm_dialog=guard.confirm_dialog)


@app.get("/{tenant_id}/mbrinq.asp")
async def member_inquiry(request: Request, tenant_id: str) -> Response:
    tenant = _tenant(tenant_id)
    guard = await _guard(request, tenant)
    if isinstance(guard, Response):
        return guard
    broken = faults_for(tenant.id).vendor_upgrade
    return _page(request, "mbrinq.html", tenant, broken=broken, confirm_dialog=guard.confirm_dialog)


@app.get("/{tenant_id}/mbrlist.asp")
async def member_list(request: Request, tenant_id: str, MBRNO: str = "", LNAME: str = "") -> Response:
    tenant = _tenant(tenant_id)
    guard = await _guard(request, tenant)
    if isinstance(guard, Response):
        return guard
    error = None
    results: list[Any] = []
    if MBRNO and not MBRNO.strip().isdigit():
        error = "INVALID MEMBER NUMBER - NUMERIC VALUE REQUIRED"
    else:
        results = find_members(MBRNO, LNAME)
    return _page(
        request,
        "mbrlist.html",
        tenant,
        results=results,
        error=error,
        tok=secrets.token_hex(4),
        confirm_dialog=guard.confirm_dialog,
    )


@app.get("/{tenant_id}/mbrdtl.asp")
async def member_detail(request: Request, tenant_id: str, M: str = "") -> Response:
    tenant = _tenant(tenant_id)
    guard = await _guard(request, tenant)
    if isinstance(guard, Response):
        return guard
    member = MEMBERS.get(M)
    if member is None:
        return _message(
            request,
            tenant,
            "MEMBER DETAIL",
            "MEMBER NOT ON FILE",
            error=True,
            link={"href": "mbrinq.asp", "text": "New Search"},
        )
    return _page(
        request,
        "mbrdtl.html",
        tenant,
        m=member,
        shares=_share_view(tenant, M),
        tok=secrets.token_hex(4),
        confirm_dialog=guard.confirm_dialog,
    )


def _funding_options(tenant: Tenant, member_number: str) -> list[tuple[str, str]]:
    options = [
        (s["suffix"], f"{s['suffix']} - {s['description']} ({s['available']})")
        for s in _share_view(tenant, member_number)
        if not s["balance"].startswith("-")
    ]
    return [*options, ("CASH", "CASH DEPOSIT")]


def _share_types(tenant: Tenant) -> list[tuple[str, str]]:
    return [(code, tenant.products.get(label, label)) for code, label in SHARE_TYPES]


@app.get("/{tenant_id}/newshr.asp")
async def new_share(request: Request, tenant_id: str, M: str = "") -> Response:
    tenant = _tenant(tenant_id)
    guard = await _guard(request, tenant)
    if isinstance(guard, Response):
        return guard
    member = MEMBERS.get(M)
    if member is None or member.restricted:
        return _message(request, tenant, "OPEN NEW SHARE", "MEMBER NOT AVAILABLE FOR THIS FUNCTION", error=True)
    form = {"SHRTYP": "", "NICK": "", "OPNAMT": "", "FUNDSRC": ""}
    return _page(
        request,
        "newshr.html",
        tenant,
        m=member,
        form=form,
        share_types=_share_types(tenant),
        funding=_funding_options(tenant, M),
        confirm_dialog=guard.confirm_dialog,
    )


def _validate_new_share(tenant: Tenant, form: dict[str, str]) -> tuple[str | None, Decimal]:
    try:
        amount = Decimal(form.get("OPNAMT", "").replace("$", "").replace(",", "").strip() or "x")
    except InvalidOperation:
        return "OPENING DEPOSIT MUST BE A DOLLAR AMOUNT", Decimal(0)
    if not form.get("SHRTYP"):
        return "SHARE TYPE IS REQUIRED", amount
    if amount < Decimal("25.00"):
        return "MINIMUM OPENING DEPOSIT IS $25.00", amount
    if not form.get("FUNDSRC"):
        return "FUNDING SOURCE IS REQUIRED", amount
    source = form["FUNDSRC"]
    if source != "CASH":
        member = MEMBERS[form["M"]]
        share = next((s for s in member.shares if s.suffix == source), None)
        if share is None or share.available < amount:
            return "INSUFFICIENT AVAILABLE FUNDS IN FUNDING SOURCE", amount
    return None, amount


@app.post("/{tenant_id}/newshr_confirm.asp")
async def new_share_confirm(request: Request, tenant_id: str) -> Response:
    tenant = _tenant(tenant_id)
    guard = await _guard(request, tenant)
    if isinstance(guard, Response):
        return guard
    form = {k: str(v) for k, v in (await request.form()).items()}
    member = MEMBERS.get(form.get("M", ""))
    if member is None or member.restricted:
        return _message(request, tenant, "OPEN NEW SHARE", "MEMBER NOT AVAILABLE FOR THIS FUNCTION", error=True)
    error, amount = _validate_new_share(tenant, form)
    if error:
        return _page(
            request,
            "newshr.html",
            tenant,
            m=member,
            form=form,
            error=error,
            share_types=_share_types(tenant),
            funding=_funding_options(tenant, member.number),
        )
    share_type = dict(_share_types(tenant))[form["SHRTYP"]]
    funding = dict(_funding_options(tenant, member.number))[form["FUNDSRC"]]
    return _page(
        request,
        "newshr_confirm.html",
        tenant,
        m=member,
        form=form,
        share_type=f"{form['SHRTYP']} - {share_type}",
        amount=money(amount),
        funding=funding,
    )


@app.post("/{tenant_id}/newshr_post.asp")
async def new_share_post(request: Request, tenant_id: str) -> Response:
    """The irreversible commit. Guardrails must keep automation from ever reaching this unapproved."""
    tenant = _tenant(tenant_id)
    guard = await _guard(request, tenant)
    if isinstance(guard, Response):
        return guard
    form = {k: str(v) for k, v in (await request.form()).items()}
    error, amount = _validate_new_share(tenant, form)
    if error:
        return _message(request, tenant, "OPEN NEW SHARE", error, error=True)
    confirmation = f"LC-{secrets.randbelow(900000) + 100000}"
    LEDGERS.setdefault(tenant.id, Ledger()).posted.append(
        {
            "confirmation": confirmation,
            "member": form["M"],
            "type": form["SHRTYP"],
            "amount": str(amount),
            "user": guard.session.user,
        }
    )
    return _message(request, tenant, "OPEN NEW SHARE", f"SHARE OPENED SUCCESSFULLY. CONFIRMATION # {confirmation}")


@app.get("/{tenant_id}/txnpost.asp")
async def transaction_posting(request: Request, tenant_id: str) -> Response:
    tenant = _tenant(tenant_id)
    guard = await _guard(request, tenant)
    if isinstance(guard, Response):
        return guard
    return _message(
        request,
        tenant,
        "TRANSACTION POSTING",
        f"FUNCTION NOT AUTHORIZED FOR USER {guard.session.user} (SEC-403)",
        error=True,
    )


# --------------------------------------------------------------------------------------------- admin API


@app.get("/__admin/faults/{tenant_id}")
async def get_faults(tenant_id: str) -> Faults:
    _tenant(tenant_id)
    return faults_for(tenant_id)


@app.put("/__admin/faults/{tenant_id}")
async def set_faults(tenant_id: str, update: dict[str, Any]) -> Faults:
    _tenant(tenant_id)
    merged = faults_for(tenant_id).model_dump() | update
    FAULT_STATE[tenant_id] = Faults.model_validate(merged)
    return FAULT_STATE[tenant_id]


@app.delete("/__admin/faults/{tenant_id}")
async def clear_faults(tenant_id: str) -> Faults:
    _tenant(tenant_id)
    FAULT_STATE[tenant_id] = Faults()
    return FAULT_STATE[tenant_id]


@app.get("/__admin/ledger/{tenant_id}")
async def ledger(tenant_id: str) -> list[dict[str, Any]]:
    _tenant(tenant_id)
    return LEDGERS.get(tenant_id, Ledger()).posted


@app.post("/__admin/reset")
async def reset() -> dict[str, str]:
    SESSIONS.clear()
    LEDGERS.clear()
    FAULT_STATE.clear()
    return {"status": "reset"}
