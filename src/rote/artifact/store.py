"""The capability library on disk: reviewable YAML under version control.

Layout::

    capabilities/<app>/app.yaml                      vendor-product profile
    capabilities/<app>/<capability-id>@<ver>.yaml    capabilities
    config/tenants/<tenant>.yaml                     per-institution bindings and overrides
    config/policy.yaml                               guardrails

Git is the registry: review is a pull request, rollback is a revert, and the file hash is what a
replay records as the exact version it executed.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel

from .schema import AppProfile, Capability, Tenant


class _Dumper(yaml.SafeDumper):
    """Block style for structure, flow style for small leaf mappings (locators, conditions)."""


def _represent_dict(dumper: yaml.SafeDumper, data: dict[str, Any]) -> yaml.Node:
    leaf = all(not isinstance(v, (dict, list)) for v in data.values())
    compact = leaf and len(data) <= 5 and sum(len(str(k)) + len(str(v)) for k, v in data.items()) < 90
    return dumper.represent_mapping("tag:yaml.org,2002:map", data.items(), flow_style=compact)


def _represent_str(dumper: yaml.SafeDumper, data: str) -> yaml.Node:
    style = "|" if "\n" in data else None
    return dumper.represent_scalar("tag:yaml.org,2002:str", data, style=style)


_Dumper.add_representer(dict, _represent_dict)
_Dumper.add_representer(str, _represent_str)


# Defaults that carry no information for a reviewer. Discriminators (type/by/do) and anything
# safety-relevant (risk, sensitivity, status, side_effects) are always written out.
_NOISE: dict[str, Any] = {
    "expect": [],
    "query": {},
    "regex": False,
    "timeout_ms": 15_000,
    "source": "agent",
    "required": True,
    "unless": [],
    "handlers": [],
    "secrets": {},
    "inputs": {},
    "outputs": {},
    "human_steps": [],
    "origin": "authored",
    "max_attempts": 2,
    "overrides": [],
    "steps": {},
}


def _prune(node: Any) -> Any:
    if isinstance(node, dict):
        return {k: _prune(v) for k, v in node.items() if not (k in _NOISE and v == _NOISE[k])}
    if isinstance(node, list):
        return [_prune(v) for v in node]
    return node


def to_yaml(model: BaseModel) -> str:
    """Serialise for review: uninformative defaults are omitted so every remaining line means something."""
    data = _prune(model.model_dump(mode="json", by_alias=True, exclude_none=True))
    return yaml.dump(data, Dumper=_Dumper, sort_keys=False, allow_unicode=True, width=110)


def load_yaml[M: BaseModel](path: Path, model: type[M]) -> M:
    with path.open() as fh:
        return model.model_validate(yaml.safe_load(fh))


def version_key(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split("."))


class Library:
    def __init__(self, root: Path):
        self.root = root
        self.capabilities_dir = root / "capabilities"
        self.tenants_dir = root / "config" / "tenants"

    # ------------------------------------------------------------------ apps & tenants

    def app(self, app_id: str) -> AppProfile:
        return load_yaml(self.capabilities_dir / app_id / "app.yaml", AppProfile)

    def tenant(self, tenant_id: str) -> Tenant:
        path = self.tenants_dir / f"{tenant_id}.yaml"
        if not path.exists():
            raise FileNotFoundError(f"unknown tenant {tenant_id!r} (expected {path})")
        return load_yaml(path, Tenant)

    def tenants(self) -> list[Tenant]:
        return [load_yaml(p, Tenant) for p in sorted(self.tenants_dir.glob("*.yaml"))]

    # ------------------------------------------------------------------ capabilities

    def capability_path(self, capability_id: str, version: str) -> Path:
        app_id = capability_id.split(".", 1)[0]
        return self.capabilities_dir / app_id / f"{capability_id}@{version}.yaml"

    def capabilities(self) -> list[Capability]:
        return [load_yaml(p, Capability) for p in sorted(self.capabilities_dir.glob("*/*@*.yaml"))]

    def versions(self, capability_id: str) -> list[str]:
        app_id = capability_id.split(".", 1)[0]
        paths = (self.capabilities_dir / app_id).glob(f"{capability_id}@*.yaml")
        return sorted((p.stem.split("@", 1)[1] for p in paths), key=version_key)

    def capability(self, ref: str) -> Capability:
        """Load ``id@version``, or the newest non-deprecated version when no version is given."""
        capability_id, _, version = ref.partition("@")
        versions = [version] if version else list(reversed(self.versions(capability_id)))
        if not versions:
            raise FileNotFoundError(f"no capability named {capability_id!r} in {self.capabilities_dir}")
        for candidate in versions:
            cap = load_yaml(self.capability_path(capability_id, candidate), Capability)
            if version or cap.status != "deprecated":
                return cap
        raise FileNotFoundError(f"every version of {capability_id!r} is deprecated")

    def has(self, capability_id: str) -> bool:
        return bool(self.versions(capability_id))

    def save(self, capability: Capability) -> Path:
        path = self.capability_path(capability.id, capability.version)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(to_yaml(capability))
        return path


def export_json_schemas(target: Path) -> list[Path]:
    """Write JSON Schemas so reviewers and other tooling can validate artifacts without Python."""
    target.mkdir(parents=True, exist_ok=True)
    written = []
    models: dict[str, type[BaseModel]] = {"capability": Capability, "app": AppProfile, "tenant": Tenant}
    for name, model in models.items():
        path = target / f"{name}.schema.json"
        path.write_text(json.dumps(model.model_json_schema(by_alias=True), indent=2) + "\n")
        written.append(path)
    return written
