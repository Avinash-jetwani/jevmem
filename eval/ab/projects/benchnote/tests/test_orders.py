def test_create_and_list_order(client):
    r = client.post("/customers/", data={"name": "Ada Byron", "email": "ada@example.test"})
    assert r.status_code == 302
    r = client.post("/orders/", data={"customer_id": 1, "device": "Fairphone 5", "problem": "Cracked screen"})
    assert r.status_code == 302
    page = client.get("/orders/").get_data(as_text=True)
    assert "Fairphone 5" in page
    assert "received" in page


def test_ready_sends_mail(client, app):
    client.post("/customers/", data={"name": "Ada Byron", "email": "ada@example.test"})
    client.post("/orders/", data={"customer_id": 1, "device": "Laptop", "problem": "No power"})
    r = client.post("/orders/1/status", data={"status": "ready"})
    assert r.status_code == 302
    assert len(app.config["SENT_MAIL"]) == 1
    assert app.config["SENT_MAIL"][0]["To"] == "ada@example.test"
