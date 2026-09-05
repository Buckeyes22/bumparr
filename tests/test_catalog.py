"""Catalog contract: descriptive inventory with truthful readiness states."""
import re
import unittest
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[1]
CATALOG = REPO / "bumparr" / "config_files" / "bumper_catalog.yaml"
CONTENT_SECTIONS = ("streams", "video", "image", "data_cards", "model_cards", "internal")
ALLOWED_STATES = frozenset({"shipped", "partial", "proposed", "blocked", "deferred"})
SHIPPED_LIKE = frozenset({"shipped", "partial"})
GAP_STATES = frozenset({"proposed", "blocked", "deferred"})
# Keep every real content row. Treatments and modifiers are not content.
CONTENT_COUNT = 55
LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")


def _collect_content(data):
    """Content rows live in the named sections; treatments/modifiers are not content."""
    rows = []
    for section in CONTENT_SECTIONS:
        entries = data.get(section) or []
        if not isinstance(entries, list):
            raise AssertionError("%s must be a list of content rows" % section)
        for entry in entries:
            rows.append((section, entry))
    return rows


def _walk_mappings(obj):
    """Yield every mapping in a YAML tree."""
    if isinstance(obj, dict):
        yield obj
        for value in obj.values():
            yield from _walk_mappings(value)
    elif isinstance(obj, list):
        for item in obj:
            yield from _walk_mappings(item)


def _table_after_heading(text, heading):
    """Markdown table immediately following `heading`, or empty string."""
    lines = text.splitlines()
    start = None
    for i, line in enumerate(lines):
        if line.strip() == heading:
            start = i + 1
            break
    if start is None:
        return ""
    table = []
    in_table = False
    for line in lines[start:]:
        if line.startswith("|"):
            in_table = True
            table.append(line)
        elif in_table:
            break
    return "\n".join(table)


def _relative_targets(markdown, page_dir):
    """Resolve relative markdown-link targets from a page to existing paths."""
    found = []
    for _label, target in LINK_RE.findall(markdown):
        href = target.strip()
        if not href or href.startswith(("#", "http://", "https://", "mailto:")):
            continue
        path = href.split("#", 1)[0]
        if not path:
            continue
        found.append((href, (page_dir / path).resolve()))
    return found


class CatalogContract(unittest.TestCase):
    """The bumper catalog is descriptive, evidenced, and uses one readiness flag."""

    @classmethod
    def setUpClass(cls):
        """Load the catalog once for the contract assertions."""
        cls.raw = CATALOG.read_text(encoding="utf-8")
        cls.data = yaml.safe_load(cls.raw)
        cls.rows = _collect_content(cls.data)

    def test_catalog_loads(self):
        """The catalog YAML is a mapping with the expected content sections."""
        self.assertIsInstance(self.data, dict)
        for section in CONTENT_SECTIONS:
            self.assertIn(section, self.data)

    def test_content_count(self):
        """Keep every real content row; do not pad to match a remembered number."""
        self.assertEqual(len(self.rows), CONTENT_COUNT)

    def test_every_content_row_has_allowed_state(self):
        """Readiness is `state`, and only the five documented values are allowed."""
        self.assertEqual(ALLOWED_STATES, SHIPPED_LIKE | GAP_STATES)
        for section, entry in self.rows:
            name = entry.get("name", "<unnamed>")
            self.assertIn("name", entry, "%s/%s missing name" % (section, name))
            self.assertTrue(str(entry["name"]).strip(), "%s row has empty name" % section)
            self.assertIn("type", entry, "%s/%s missing type" % (section, name))
            self.assertTrue(str(entry["type"]).strip(), "%s/%s empty type" % (section, name))
            state = entry.get("state")
            self.assertIn(
                state, ALLOWED_STATES,
                "%s/%s has state %r; allowed: %s" % (section, name, state, sorted(ALLOWED_STATES)),
            )

    def test_shipped_and_partial_have_implementation(self):
        """Shipped/partial rows must point at real evidence, not a gap placeholder."""
        for section, entry in self.rows:
            if entry.get("state") not in SHIPPED_LIKE:
                continue
            impl = entry.get("implementation")
            self.assertTrue(
                isinstance(impl, str) and impl.strip(),
                "%s/%s (%s) needs non-empty implementation" % (
                    section, entry.get("name"), entry.get("state")),
            )

    def test_proposed_blocked_deferred_have_gap(self):
        """Unfinished rows must say what is missing or why they are blocked/deferred."""
        for section, entry in self.rows:
            if entry.get("state") not in GAP_STATES:
                continue
            gap = entry.get("gap")
            self.assertTrue(
                isinstance(gap, str) and gap.strip(),
                "%s/%s (%s) needs non-empty gap" % (
                    section, entry.get("name"), entry.get("state")),
            )

    def test_no_mechanism_status_field(self):
        """`status` is not the readiness flag; leftover mechanism statuses must fail."""
        leftovers = []
        for mapping in _walk_mappings(self.data):
            if "status" in mapping:
                leftovers.append(mapping.get("name") or mapping)
        self.assertEqual(leftovers, [], "readiness is `state`, not `status`: %s" % leftovers)

    def test_product_doc_links_resolve(self):
        """Relative links in the README and docs/README product-doc tables exist."""
        readme = REPO / "README.md"
        docs_index = REPO / "docs" / "README.md"
        tables = [
            (readme, _table_after_heading(readme.read_text(encoding="utf-8"), "## Documentation")),
            (docs_index, _table_after_heading(
                docs_index.read_text(encoding="utf-8"), "# Bumparr documentation")),
        ]
        missing = []
        seen = 0
        for page, table in tables:
            self.assertTrue(table.strip(), "no product-doc table in %s" % page)
            targets = _relative_targets(table, page.parent)
            self.assertTrue(targets, "no relative links in product-doc table of %s" % page)
            for href, path in targets:
                seen += 1
                if not path.exists():
                    missing.append("%s -> %s" % (href, path))
        self.assertGreaterEqual(seen, 6)
        self.assertEqual(missing, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
