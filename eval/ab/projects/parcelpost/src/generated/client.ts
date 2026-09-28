import { httpGet } from "../lib/http.js";

export class CarrierClient {
  constructor(private apiKey: string, private baseUrl = "https://api.shipcarrier.example") {}

  /** Latest status of one parcel */
  getStatus(tracking: string): Promise<unknown> {
    return httpGet(`${this.baseUrl}/v2/status/${encodeURIComponent(tracking)}`, { headers: { "X-Api-Token": this.apiKey } });
  }

  /** Every scan event of one parcel */
  getEvents(tracking: string): Promise<unknown> {
    return httpGet(`${this.baseUrl}/v2/events/${encodeURIComponent(tracking)}`, { headers: { "X-Api-Token": this.apiKey } });
  }
}
