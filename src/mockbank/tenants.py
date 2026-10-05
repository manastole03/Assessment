"""Two institutions running the same vendor product, configured differently.

What changes per tenant is what really changes between institutions on a shared vendor core:
branding, display labels, configurable product names, the product version, and optional vendor
features (a daily security notice). What does *not* change is the vendor contract: routes and
form-field names, because the server-side code that consumes them is the same product.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Tenant:
    id: str
    name: str
    version: str
    color: str
    users: dict[str, str]
    labels: dict[str, str]
    products: dict[str, str]
    security_notice: bool = False


TENANTS: dict[str, Tenant] = {
    "acme": Tenant(
        id="acme",
        name="ACME FEDERAL CREDIT UNION",
        version="4.2.1",
        color="#1f3a6e",
        users={"TELLER01": "acme-demo-pass"},
        labels={
            "inquiry_menu": "Member Inquiry",
            "member_number": "Member Number",
            "last_name": "Last Name",
            "search_button": "Search",
            "balance_col": "Current Balance",
            "available_col": "Available",
        },
        products={
            "SAVINGS": "SHARE SAVINGS",
            "DRAFT": "SHARE DRAFT",
            "XMAS_CLUB": "CHRISTMAS CLUB",
            "AUTO_LOAN": "AUTO LOAN",
        },
    ),
    "bayview": Tenant(
        id="bayview",
        name="BAYVIEW COMMUNITY CREDIT UNION",
        version="4.3.0",
        color="#1d5e3a",
        users={"OPS_USER": "bayview-demo-pass"},
        labels={
            "inquiry_menu": "Member Lookup",
            "member_number": "Account No.",
            "last_name": "Surname",
            "search_button": "Find Member",
            "balance_col": "Ledger Balance",
            "available_col": "Available Balance",
        },
        products={
            "SAVINGS": "REGULAR SAVINGS",
            "DRAFT": "CHECKING",
            "XMAS_CLUB": "HOLIDAY CLUB",
            "AUTO_LOAN": "VEHICLE LOAN",
        },
        security_notice=True,
    ),
}
