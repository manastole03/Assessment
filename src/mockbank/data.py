"""Synthetic member data. Every name, SSN, phone number and balance here is fabricated."""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal


@dataclass(frozen=True)
class Share:
    suffix: str
    product: str  # vendor product code; the tenant decides the display name
    balance: Decimal
    available: Decimal
    status: str = "OPEN"


@dataclass(frozen=True)
class Member:
    number: str
    name: str
    branch: str
    since: str
    ssn: str
    dob: str
    phone: str
    email: str
    status: str = "ACTIVE"
    restricted: bool = False
    shares: tuple[Share, ...] = field(default_factory=tuple)


MEMBERS: dict[str, Member] = {
    m.number: m
    for m in [
        Member(
            number="12345",
            name="SAMPLE, JORDAN Q",
            branch="001 - MAIN OFFICE",
            since="03/14/2009",
            ssn="123-45-6789",
            dob="04/12/1984",
            phone="(555) 010-4477",
            email="jordan.sample@example.com",
            shares=(
                Share("00", "SAVINGS", Decimal("2418.07"), Decimal("2393.07")),
                Share("10", "DRAFT", Decimal("812.44"), Decimal("812.44")),
                Share("70", "AUTO_LOAN", Decimal("-9120.33"), Decimal("0.00")),
            ),
        ),
        # Same products in a different order: extraction must be anchored by meaning, not position.
        Member(
            number="20417",
            name="RIVERA, ALEX M",
            branch="003 - HARBOR",
            since="11/02/2016",
            ssn="234-56-7890",
            dob="09/30/1991",
            phone="(555) 010-2211",
            email="alex.rivera@example.com",
            shares=(
                Share("10", "DRAFT", Decimal("95.10"), Decimal("95.10")),
                Share("01", "XMAS_CLUB", Decimal("300.00"), Decimal("300.00")),
                Share("00", "SAVINGS", Decimal("15002.50"), Decimal("14977.50")),
            ),
        ),
        # No savings share at all: a legitimate business outcome, not a UI failure.
        Member(
            number="31008",
            name="NGUYEN, PAT",
            branch="002 - WESTSIDE",
            since="06/21/2021",
            ssn="345-67-8901",
            dob="01/05/1979",
            phone="(555) 010-9034",
            email="pat.nguyen@example.com",
            shares=(Share("10", "DRAFT", Decimal("1204.99"), Decimal("1204.99")),),
        ),
        # Employee account: the operator is not entitled to view it (permission denial in-flow).
        Member(
            number="40404",
            name="EMPLOYEE, RESTRICTED",
            branch="001 - MAIN OFFICE",
            since="01/01/2015",
            ssn="456-78-9012",
            dob="07/07/1970",
            phone="(555) 010-0000",
            email="restricted@example.com",
            restricted=True,
            shares=(Share("00", "SAVINGS", Decimal("50000.00"), Decimal("50000.00")),),
        ),
    ]
}


def find_members(number: str, last_name: str) -> list[Member]:
    number = number.strip()
    last_name = last_name.strip().upper()
    results = []
    for member in MEMBERS.values():
        if number and member.number != number:
            continue
        if last_name and not member.name.startswith(last_name):
            continue
        results.append(member)
    return results


def money(value: Decimal) -> str:
    sign = "-" if value < 0 else ""
    return f"{sign}${abs(value):,.2f}"
