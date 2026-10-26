from datetime import datetime, timezone

from flask import Blueprint, abort, redirect, render_template, request, url_for

from .. import db

bp = Blueprint("customers", __name__, url_prefix="/customers")


@bp.get("/")
def list_customers():
    rows = db.query("SELECT * FROM customers ORDER BY name")
    return render_template("customers/list.html", customers=rows)


@bp.post("/")
def create_customer():
    form = request.form
    if not form.get("name"):
        abort(400)
    customer_id = db.execute(
        "INSERT INTO customers (name, phone, email, address, created_at) VALUES (?, ?, ?, ?, ?)",
        (form["name"].strip(), form.get("phone") or None, form.get("email") or None, form.get("address") or None, datetime.now(timezone.utc).isoformat(timespec="seconds")),
    )
    return redirect(url_for("customers.show_customer", customer_id=customer_id))


@bp.get("/<int:customer_id>")
def show_customer(customer_id: int):
    customer = db.one("SELECT * FROM customers WHERE id = ?", (customer_id,))
    if customer is None:
        abort(404)
    orders = db.query("SELECT * FROM work_orders WHERE customer_id = ? ORDER BY created_at DESC", (customer_id,))
    return render_template("customers/detail.html", customer=customer, orders=orders)
