from flask import Blueprint, render_template

from ..db import q

bp = Blueprint("rooms", __name__)


@bp.get("/rooms")
def list_rooms():
    rows = q("SELECT id, name, capacity, last_cleaned_at FROM rooms ORDER BY name").fetchall()
    return render_template("rooms/list.html", rooms=rows)
