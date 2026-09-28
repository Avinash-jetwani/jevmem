import express from "express";
import { parcels } from "./routes/parcels.js";

const app = express();
app.use(express.json());
app.use("/v1/parcels", parcels);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`parcelpost listening on ${port}`);
});
