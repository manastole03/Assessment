"""Eval datasets: versioned YAML in git, validated like every other artifact.

A dataset is one of three kinds, each measuring a different part of the system:

* ``replay`` — the deterministic engine. Cases pin inputs, tenant and injected faults to an exact
  expected result (status, outputs, outcome or failure code, recoveries, tolerated drift).
* ``probe`` — screen classification. Each case replays an artifact *without* outcome handlers onto an
  off-happy-path screen; the classifier (the model, or a rule stand-in offline) must name it, and the
  guarded handler must — or, for drift, must *not* — be proposed.
* ``discovery`` — the agent. The recorded artifact is graded on its contract, on whether it is free
  of data, and on held-out replays with inputs the agent never saw, plus an optional model-graded
  rubric.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Annotated, Any, Literal

import yaml
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, TypeAdapter

CaseId = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9-]*$")]
DatasetId = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_-]*$")]
RunStatus = Literal["succeeded", "business_outcome", "failed"]
ValueType = Literal["string", "integer", "decimal", "money", "date", "boolean"]
LibraryScope = Literal["all", "session", "app"]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


# ============================================================================================ replay


class ReplayExpect(_Model):
    status: RunStatus
    outputs: dict[str, str] | None = Field(None, description="Exact outputs, as returned to the caller.")
    outcome: str | None = Field(None, description="Business-outcome code (status business_outcome).")
    failure: list[str] | None = Field(None, description="Acceptable failure codes (status failed).")
    recoveries: list[str] = Field(default_factory=list, description="Handlers that must have recovered the run.")
    warnings: list[str] | None = Field(None, description="Warning codes tolerated; any other is a regression.")
    max_duration_ms: int | None = Field(None, gt=0)


class _CaseBase(_Model):
    id: CaseId
    title: str
    tags: list[str] = Field(default_factory=list)
    tenant: str = "acme"
    inputs: dict[str, str] = Field(default_factory=dict)
    faults: dict[str, Any] = Field(default_factory=dict, description="Injected into the mock before the case.")
    tenant_overrides: bool = Field(True, description="False runs the tenant without its reviewed overrides.")
    library: LibraryScope | None = Field(None, description="Overrides the dataset's library scope.")


class ReplayCase(_CaseBase):
    capability: str | None = Field(None, description="id or id@version; defaults to the dataset's.")
    expect: ReplayExpect


# ============================================================================================ probe


class ProbeExpect(_Model):
    handler: Literal["proposed", "none"] = Field(
        description="Whether a verified handler must come out. 'none' is the safety property for drift."
    )
    kind: Literal["business_outcome", "failure", "unknown"] | None = None
    code_pattern: str | None = Field(None, description="Regex the proposed outcome code must match.")
    evidence_type: Literal["message", "absence"] | None = None


class ProbeCase(_CaseBase):
    capability: str | None = None
    expect: ProbeExpect


# ============================================================================================ discovery


class HoldoutCase(_Model):
    """A replay of the freshly recorded artifact with inputs the agent never saw."""

    title: str
    tenant: str = "acme"
    inputs: dict[str, str] = Field(default_factory=dict)
    expect: ReplayExpect


class DiscoveryExpect(_Model):
    status: RunStatus = "succeeded"
    inputs: list[str] | None = Field(None, description="Exactly these inputs must be declared.")
    outputs: dict[str, ValueType] | None = Field(None, description="Declared outputs and their types.")
    sensitive: list[str] = Field(default_factory=list, description="Inputs/outputs that must be pii or secret.")
    max_turns: int = Field(30, ge=3, le=80)
    max_cost_usd: float | None = Field(None, gt=0)


class DiscoveryCase(_CaseBase):
    goal: str
    kind: Literal["task", "session"] = "task"
    capability_id: str | None = None
    standin: str = Field(description="Scripted plan that stands in for the model in offline mode.")
    expect: DiscoveryExpect
    holdout: list[HoldoutCase] = Field(default_factory=list)
    rubric: bool = Field(False, description="Grade the contract with the model-graded rubric (live mode).")


# ============================================================================================ datasets


class _DatasetBase(_Model):
    schema_: Literal["rote.eval/v1"] = Field("rote.eval/v1", alias="schema")
    id: DatasetId
    title: str
    description: str
    capability: str | None = Field(None, description="Default capability for replay/probe cases.")
    library: LibraryScope = Field("all", description="Which part of the library each case's sandbox starts with.")
    threshold: float = Field(1.0, ge=0, le=1, description="Minimum pass rate for the suite to pass its gate.")

    @property
    def uses_model(self) -> bool:
        return False


def _unique_ids[C: _CaseBase](cases: list[C]) -> list[C]:
    ids = [case.id for case in cases]
    duplicates = sorted({i for i in ids if ids.count(i) > 1})
    if duplicates:
        raise ValueError(f"duplicate case ids: {', '.join(duplicates)}")
    return cases


class ReplayDataset(_DatasetBase):
    kind: Literal["replay"]
    cases: Annotated[list[ReplayCase], AfterValidator(_unique_ids), Field(min_length=1)]


class ProbeDataset(_DatasetBase):
    kind: Literal["probe"]
    cases: Annotated[list[ProbeCase], AfterValidator(_unique_ids), Field(min_length=1)]

    @property
    def uses_model(self) -> bool:
        return True


class DiscoveryDataset(_DatasetBase):
    kind: Literal["discovery"]
    cases: Annotated[list[DiscoveryCase], AfterValidator(_unique_ids), Field(min_length=1)]

    @property
    def uses_model(self) -> bool:
        return True


EvalDataset = Annotated[ReplayDataset | ProbeDataset | DiscoveryDataset, Field(discriminator="kind")]
_ADAPTER: TypeAdapter[ReplayDataset | ProbeDataset | DiscoveryDataset] = TypeAdapter(EvalDataset)


def datasets_dir(root: Path) -> Path:
    return root / "evals" / "datasets"


def parse_dataset(text: str) -> ReplayDataset | ProbeDataset | DiscoveryDataset:
    return _ADAPTER.validate_python(yaml.safe_load(text))


def dataset_sha(text: str) -> str:
    """Content hash recorded with every result, so scores are only compared on identical datasets."""
    return hashlib.sha256(text.encode()).hexdigest()[:12]


def load_dataset(root: Path, dataset_id: str) -> tuple[ReplayDataset | ProbeDataset | DiscoveryDataset, str]:
    path = datasets_dir(root) / f"{dataset_id}.yaml"
    if not path.is_file():
        raise FileNotFoundError(f"no eval dataset {dataset_id!r} in {datasets_dir(root)}")
    text = path.read_text()
    dataset = parse_dataset(text)
    if dataset.id != dataset_id:
        raise ValueError(f"{path.name} declares id {dataset.id!r}; the file name must match")
    return dataset, dataset_sha(text)


def load_datasets(root: Path) -> list[ReplayDataset | ProbeDataset | DiscoveryDataset]:
    return [load_dataset(root, p.stem)[0] for p in sorted(datasets_dir(root).glob("*.yaml"))]


def dataset_json_schema() -> dict[str, Any]:
    return _ADAPTER.json_schema(by_alias=True)
