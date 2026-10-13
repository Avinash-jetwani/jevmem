from sundial.i18n import t


def test_empty_list_says_so(client):
    r = client.get("/bookings")
    assert r.status_code == 200
    assert t("bookings.empty") in r.get_data(as_text=True)


def test_create_then_list(client):
    r = client.post("/bookings", data={"room_id": 1, "starts_at": "2026-04-10T18:30", "member_name": "Noor"})
    assert r.status_code == 302
    page = client.get("/bookings").get_data(as_text=True)
    assert "Noor" in page
    assert "Garden room" in page


def test_missing_fields_flash(client):
    r = client.post("/bookings", data={"room_id": 1}, follow_redirects=True)
    assert t("bookings.missing_fields") in r.get_data(as_text=True)


def test_full_room_is_refused(client):
    for i in range(8):
        client.post("/bookings", data={"room_id": 2, "starts_at": "2026-04-10T18:30", "member_name": f"Member {i}"})
    r = client.post("/bookings", data={"room_id": 2, "starts_at": "2026-04-10T18:30", "member_name": "One too many"})
    assert r.status_code == 409
