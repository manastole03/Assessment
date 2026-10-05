"""A scripted stand-in for a human operator, driving the *real* console API.

It does exactly what a person does in the console: wait for an intervention, take control (receiving
a lease epoch), look at the screen, click, and hand control back with a resolution and a note. Used
to produce reproducible handoff evidence; `make demo-handoff` lets you do the same by hand.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx


async def wait_for_intervention(client: httpx.AsyncClient, timeout_s: float = 120) -> dict[str, Any]:
    for _ in range(int(timeout_s * 10)):
        state = (await client.get("/api/state")).json()
        if state["active"] and state["active"]["status"] == "open":
            return state["active"]
        await asyncio.sleep(0.1)
    raise TimeoutError("no intervention was raised")


async def complete_attestation(console_url: str, operator: str = "dana.ops") -> dict[str, Any]:
    """Handle the compliance-attestation screen no automation knows about."""
    async with httpx.AsyncClient(base_url=console_url, timeout=15) as client:
        item = await wait_for_intervention(client)
        await asyncio.sleep(1.5)  # a person reads the request before acting
        epoch = (await client.post(f"/api/interventions/{item['id']}/claim", json={"operator": operator})).json()[
            "epoch"
        ]
        screen = (await client.get("/api/screen")).json()["elements"]
        checkbox = next(e for e in screen if e["role"] == "checkbox")
        button = next(e for e in screen if e["role"] == "button" and e["name"] == "Continue")
        for element in (checkbox, button):
            await asyncio.sleep(0.8)
            response = await client.post(
                "/api/input",
                json={"operator": operator, "epoch": epoch, "kind": "click", "x": element["x"], "y": element["y"]},
            )
            response.raise_for_status()
        await asyncio.sleep(1.5)
        response = await client.post(
            f"/api/interventions/{item['id']}/resolve",
            json={
                "operator": operator,
                "epoch": epoch,
                "resolution": "step_completed",
                "note": "Completed the annual BSA/AML attestation for the service account; Member Inquiry is open.",
            },
        )
        response.raise_for_status()
        late = await client.post(
            "/api/input", json={"operator": operator, "epoch": epoch, "kind": "press", "key": "Tab"}
        )
        item["late_input_status"] = late.status_code  # 409: stale lease epoch after hand-back
        return item
