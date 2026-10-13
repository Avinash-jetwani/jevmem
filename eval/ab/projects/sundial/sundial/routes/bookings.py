from flask import Blueprint, abort, flash, redirect, render_template, request, url_for

from .. import mail, settings
from ..db import q
from ..i18n import t

bp = Blueprint("bookings", __name__)


@bp.get("/bookings")
def list_bookings():
    rows = q(
        "SELECT b.id, b.member_name, b.starts_at, b.cancelled_at, r.name AS room "
        "FROM bookings b JOIN rooms r ON r.id = b.room_id ORDER BY b.starts_at DESC LIMIT ?",
        (settings.get("page_size"),),
    ).fetchall()
    return render_template("bookings/list.html", bookings=rows)


@bp.get("/bookings/new")
def new_booking():
    rooms = q("SELECT id, name FROM rooms ORDER BY name").fetchall()
    return render_template("bookings/new.html", rooms=rooms)


@bp.post("/bookings")
def create_booking():
    room_id = request.form.get("room_id", type=int)
    starts_at = request.form.get("starts_at", "").strip()
    member = request.form.get("member_name", "").strip()
    email = request.form.get("member_email", "").strip()
    if not (room_id and starts_at and member):
        flash(t("bookings.missing_fields"), "error")
        return redirect(url_for("bookings.new_booking"))
    room = q("SELECT capacity FROM rooms WHERE id = ?", (room_id,)).fetchone()
    if room is None:
        abort(404)
    taken = q(
        "SELECT COUNT(*) FROM bookings WHERE room_id = ? AND starts_at = ? AND cancelled_at IS NULL",
        (room_id, starts_at),
    ).fetchone()[0]
    if taken >= room["capacity"]:
        flash(t("bookings.room_full"), "error")
        return redirect(url_for("bookings.new_booking")), 409
    window = f"-{settings.get('duplicate_window_seconds')} seconds"
    recent = q(
        "SELECT COUNT(*) FROM bookings WHERE room_id = ? AND starts_at = ? AND member_name = ? AND created_at > datetime('now', ?)",
        (room_id, starts_at, member, window),
    ).fetchone()[0]
    if recent:
        return redirect(url_for("bookings.list_bookings"))
    q(
        "INSERT INTO bookings (room_id, member_name, member_email, starts_at) VALUES (?, ?, ?, ?)",
        (room_id, member, email, starts_at),
    )
    if email:
        # The confirmation goes out before the response: the SMTP round trip is what makes this route slow.
        mail.send(email, t("mail.confirmation_subject"), t("mail.confirmation_body", when=starts_at))
    flash(t("bookings.created"), "ok")
    return redirect(url_for("bookings.list_bookings"))
