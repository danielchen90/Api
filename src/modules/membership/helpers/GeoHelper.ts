import { Church, Campus } from "../models/index.js";
import NodeGeocoder from "node-geocoder";
import { Repos } from "../repositories/index.js";
import { RepoManager } from "../../../shared/infrastructure/index.js";

export class GeoHelper {
  // Geocode a campus address to latitude/longitude for map display.
  // Unlike updateChurchAddress, this ONLY sets lat/lng and never rewrites the
  // address fields — campus addresses are curated (imported from Elvanto) and
  // must not be clobbered by the geocoder's normalized result.
  static async updateCampusAddress(campus: Campus) {
    const options: NodeGeocoder.Options = { provider: "openstreetmap" };
    const geocoder = NodeGeocoder(options);
    const query = [campus.address1, campus.address2, campus.city, campus.state, campus.zip, campus.country].filter(Boolean).join(" ").trim();
    if (!query) return;
    const resp: NodeGeocoder.Entry[] = await geocoder.geocode(query);
    if (resp.length > 0) {
      campus.latitude = resp[0].latitude;
      campus.longitude = resp[0].longitude;
      await (await RepoManager.getRepos<Repos>("membership")).campus.save(campus);
    }
  }

  static async updateChurchAddress(church: Church) {
    const options: NodeGeocoder.Options = { provider: "openstreetmap" };
    const geocoder = NodeGeocoder(options);
    const resp: NodeGeocoder.Entry[] = await geocoder.geocode(church.address1 + " " + church.address2 + " " + church.city + ", " + church.state + " " + church.zip + " " + church.country);
    if (resp.length > 0) {
      const r = resp[0];
      if (r.streetNumber) {
        church.address1 = (r.streetNumber + " " + r.streetName).trim();
        church.city = r.city;
        church.state = r.state || r.district;
        church.country = r.country;
        church.zip = r.zipcode;
      }
      church.latitude = r.latitude;
      church.longitude = r.longitude;
      (await RepoManager.getRepos<Repos>("membership")).church.save(church);
    }
  }
}
