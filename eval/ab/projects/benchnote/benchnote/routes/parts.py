from flask import Blueprint, abort, redirect, request, url_for

from .. import db

bp = Blueprint("parts", __name__, url_prefix="/orders/<int:order_id>/parts")


@bp.post("/")
def add_part(order_id: int):
    form = request.form
    if db.one("SELECT id FROM work_orders WHERE id = ?", (order_id,)) is None:
        abort(404)
    if not form.get("name") or not form.get("unit_price"):
        abort(400)
    db.execute(
        "INSERT INTO parts (order_id, name, qty, unit_price) VALUES (?, ?, ?, ?)",
        (order_id, form["name"].strip(), int(form.get("qty") or 1), float(form["unit_price"])),
    )
    return redirect(url_for("orders.show_order", order_id=order_id))


@bp.post("/<int:part_id>/remove")
def remove_part(order_id: int, part_id: int):
    db.execute("DELETE FROM parts WHERE id = ? AND order_id = ?", (part_id, order_id))
    return redirect(url_for("orders.show_order", order_id=order_id))
