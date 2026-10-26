from datetime import datetime, timezone

from flask import Blueprint, abort, flash, redirect, render_template, request, url_for

from .. import db
from ..mail import send_mail

bp = Blueprint("orders", __name__, url_prefix="/orders")

STATUSES = ("received", "diagnosing", "waiting_parts", "in_repair", "ready", "collected")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@bp.get("/")
def list_orders():
    rows = db.query(
        "SELECT o.*, c.name AS customer_name FROM work_orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.created_at DESC"
    )
    return render_template("orders/list.html", orders=rows, statuses=STATUSES)


@bp.get("/new")
def new_order():
    customers = db.query("SELECT id, name FROM customers ORDER BY name")
    return render_template("orders/new.html", customers=customers)


@bp.post("/")
def create_order():
    form = request.form
    if not form.get("customer_id") or not form.get("device") or not form.get("problem"):
        abort(400)
    stamp = now_iso()
    order_id = db.execute(
        "INSERT INTO work_orders (customer_id, device, problem, status, labour_rate, created_at, updated_at) VALUES (?, ?, ?, 'received', ?, ?, ?)",
        (int(form["customer_id"]), form["device"].strip(), form["problem"].strip(), float(form.get("labour_rate") or 60.0), stamp, stamp),
    )
    return redirect(url_for("orders.show_order", order_id=order_id))


@bp.get("/<int:order_id>")
def show_order(order_id: int):
    order = db.one(
        "SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email FROM work_orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?",
        (order_id,),
    )
    if order is None:
        abort(404)
    parts = db.query("SELECT * FROM parts WHERE order_id = ? ORDER BY id", (order_id,))
    parts_total = sum(p["qty"] * p["unit_price"] for p in parts)
    return render_template("orders/detail.html", order=order, parts=parts, parts_total=parts_total, statuses=STATUSES)


@bp.post("/<int:order_id>/status")
def set_status(order_id: int):
    status = request.form.get("status", "")
    if status not in STATUSES:
        abort(400)
    order = db.one("SELECT o.*, c.email AS customer_email, c.name AS customer_name FROM work_orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?", (order_id,))
    if order is None:
        abort(404)
    db.execute("UPDATE work_orders SET status = ?, updated_at = ? WHERE id = ?", (status, now_iso(), order_id))
    if status == "ready" and order["customer_email"]:
        send_mail(order["customer_email"], "Your repair is ready", f"Hello {order['customer_name']},\n\nyour {order['device']} is repaired and ready for pickup.\n\nbenchnote")
    flash(f"Status set to {status}")
    return redirect(url_for("orders.show_order", order_id=order_id))
