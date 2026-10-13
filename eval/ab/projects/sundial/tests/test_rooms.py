def test_rooms_lists_both(client):
    page = client.get("/rooms").get_data(as_text=True)
    assert "Garden room" in page
    assert "Loft" in page
    assert "12" in page and "8" in page
