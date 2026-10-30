from floorguard.agents.llm import _template
from floorguard.agents.loop import Brief, PlannerOut, StressPick
from floorguard.jsonsafe import clean


def test_template_shows_lists_as_lists_and_types():
    t = _template(StressPick)
    assert isinstance(t["tests"], list)
    p = _template(PlannerOut)
    assert isinstance(p["packages"], list) and "ped_gate" in p["packages"][0]
    assert "true/false" in p["packages"][0]["ped_gate"]


def test_brief_asks_for_real_world_checks():
    assert "real-world" in Brief.model_fields["after_install"].description


def test_clean_removes_non_finite_numbers():
    assert clean({"a": float("inf"), "b": [1.0, float("nan")], "c": "x"}) == {"a": None, "b": [1.0, None], "c": "x"}
