"""Eval API: datasets, results, and runs started from the UI.

Datasets are read-only here — like capabilities, they change through review in git. An eval runs in
the background on the server's event loop with its own private mock bank; because the bundled mock
keeps its fault switches in process-wide state, one eval runs at a time.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..evals.dataset import load_dataset, load_datasets
from ..evals.runner import EvalRun, EvalRunner, evals_dir, list_results, load_result
from ..runtime import Settings
from .models import ApiError, EvalDatasetSummary, EvalRunSummary, EvalStarted


class StartEval(BaseModel):
    dataset: str
    mode: Literal["offline", "live"] = "offline"
    trials: int = Field(1, ge=1, le=10)
    cases: list[str] | None = None


def _summary(run: EvalRun) -> dict[str, Any]:
    return {
        "id": run.id,
        "dataset": run.dataset,
        "dataset_title": run.dataset_title,
        "kind": run.kind,
        "mode": run.mode,
        "model": run.model,
        "trials": run.trials,
        "status": run.status,
        "started_at": run.started_at.isoformat(),
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
        "total_cases": run.total_cases,
        "done_cases": sum(len(c.trials) == run.trials for c in run.cases),
        "summary": run.summary.model_dump() if run.summary else None,
    }


class EvalService:
    """Owns background eval runs for the UI server; ``router`` is mounted under /api/evals."""

    def __init__(self, settings: Settings):
        self.active: dict[str, EvalRunner] = {}
        self.tasks: set[asyncio.Task[EvalRun]] = set()
        self.router = _router(settings, self.active, self.tasks)

    async def shutdown(self) -> None:
        for task in list(self.tasks):
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task


def _router(settings: Settings, active: dict[str, EvalRunner], tasks: set[asyncio.Task[EvalRun]]) -> APIRouter:
    router = APIRouter(prefix="/api/evals", tags=["evals"])
    not_found: dict[int | str, dict[str, Any]] = {404: {"model": ApiError}}

    def running() -> EvalRunner | None:
        return next((r for r in active.values() if r.result.status == "running"), None)

    def find(eval_id: str) -> EvalRun:
        if eval_id in active:
            return active[eval_id].result
        try:
            return load_result(settings, eval_id)
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(404, str(exc)) from exc

    def all_results() -> list[EvalRun]:
        merged = {r.id: r for r in list_results(settings)} | {r.result.id: r.result for r in active.values()}
        return sorted(merged.values(), key=lambda r: r.started_at, reverse=True)

    @router.get("/datasets", response_model=list[EvalDatasetSummary], summary="Datasets with their latest full run")
    async def datasets() -> list[dict[str, Any]]:
        results = [r for r in all_results() if r.status != "running"]
        out = []
        for d in load_datasets(settings.root):
            finished = [r for r in results if r.dataset == d.id]
            # A dataset's headline score is its newest *full* run; a run of a few cases only stands in when
            # there is nothing else.
            latest = next((r for r in finished if r.total_cases == len(d.cases)), finished[0] if finished else None)
            out.append(
                {
                    "id": d.id,
                    "title": d.title,
                    "description": d.description,
                    "kind": d.kind,
                    "uses_model": d.uses_model,
                    "threshold": d.threshold,
                    "cases": len(d.cases),
                    "tags": sorted({t for c in d.cases for t in c.tags}),
                    "latest": _summary(latest) if latest else None,
                }
            )
        return out

    @router.get("/datasets/{dataset_id}", responses=not_found, summary="A dataset's cases (schemas/eval-dataset)")
    async def dataset(dataset_id: str) -> dict[str, Any]:
        try:
            ds, sha = load_dataset(settings.root, dataset_id)
        except FileNotFoundError as exc:
            raise HTTPException(404, str(exc)) from exc
        return {**ds.model_dump(mode="json", by_alias=True), "uses_model": ds.uses_model, "sha": sha}

    @router.get("/results", response_model=list[EvalRunSummary], summary="Eval runs, newest first")
    async def results() -> list[dict[str, Any]]:
        return [_summary(r) for r in all_results()]

    @router.get("/results/{eval_id}", response_model=EvalRun, responses=not_found, summary="One eval run, every check")
    async def result(eval_id: str) -> EvalRun:
        return find(eval_id)

    @router.get("/results/{eval_id}/files/{path:path}", responses=not_found, summary="Evidence from an eval trial")
    async def result_file(eval_id: str, path: str) -> FileResponse:
        find(eval_id)
        base = (evals_dir(settings) / eval_id).resolve()
        target = (base / path).resolve()
        if base not in target.parents or not target.is_file():
            raise HTTPException(404, "no such file")
        return FileResponse(target)

    @router.post(
        "/runs",
        status_code=202,
        response_model=EvalStarted,
        responses={409: {"model": ApiError, "description": "Another eval is running"}, **not_found},
        summary="Start an eval in the background; poll /api/evals/results/{id}",
    )
    async def start(body: StartEval) -> EvalStarted:
        busy = running()
        if busy is not None:
            raise HTTPException(409, f"eval {busy.result.id} is still running; one eval runs at a time")
        try:
            runner = EvalRunner(settings, body.dataset, mode=body.mode, trials=body.trials, case_ids=body.cases)
        except FileNotFoundError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        active[runner.result.id] = runner
        task = asyncio.create_task(runner.execute())
        tasks.add(task)  # keep a reference so the task is not garbage-collected mid-run
        task.add_done_callback(tasks.discard)
        task.add_done_callback(lambda t: t.cancelled() or t.exception())  # failures live on the result
        return EvalStarted(id=runner.result.id)

    return router
