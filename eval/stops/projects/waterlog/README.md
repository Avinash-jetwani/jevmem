# waterlog

Records when each office plant was last watered, and by whom.

- `GET /plants` lists the plants and when each was last watered
- `POST /plants/<name>/water` with `{"by": "<email>"}` records a watering

Data is kept in `data/waterings.json`. `npm start` runs the server; `npm test` runs the tests.
