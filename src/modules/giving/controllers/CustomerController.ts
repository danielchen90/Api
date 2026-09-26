import { controller, httpGet, httpDelete, requestParam } from "inversify-express-utils";
import express from "express";
import { GivingBaseController } from "./GivingBaseController.js";
import { Permissions } from "../../../shared/helpers/Permissions.js";
import { SubscriptionListHelper } from "../helpers/SubscriptionListHelper.js";

@controller("/giving/customers")
export class CustomerController extends GivingBaseController {

  @httpGet("/:id/subscriptions")
  public async getSubscriptions(@requestParam("id") id: string, req: express.Request<{}, {}, null>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      // Check permissions
      let permission = au.checkAccess(Permissions.donations.viewSummary);
      if (!permission) {
        const customerData = await this.repos.customer.load(au.churchId, id);
        if (customerData) {
          const customer = this.repos.customer.convertToModel(au.churchId, customerData as any);
          permission = customer.personId === au.personId;
        }
      }
      if (!permission) return this.json({}, 401);

      // Look up the person associated with the requested customer
      const customerRecord = await this.repos.customer.load(au.churchId, id) as any;
      const personId = customerRecord?.personId || au.personId;

      // Return in { data: [...] } format for frontend compatibility
      return { data: await SubscriptionListHelper.load(this.repos, au.churchId, id, personId) };
    });
  }

  @httpGet("/:id")
  public async get(@requestParam("id") id: string, req: express.Request<{}, {}, null>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      const customer = await this.repos.customer.convertToModel(au.churchId, (await this.repos.customer.load(au.churchId, id)) as any);
      if (!au.checkAccess(Permissions.donations.viewSummary) && au.personId !== customer.personId) return this.json({}, 401);
      else return customer;
    });
  }

  @httpGet("/")
  public async getAll(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(Permissions.donations.viewSummary)) return this.json([], 401);
      const data = await this.repos.customer.loadAll(au.churchId);
      return this.repos.customer.convertAllToModel(au.churchId, data);
    });
  }

  @httpDelete("/:id")
  public async delete(@requestParam("id") id: string, req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(Permissions.donations.edit)) return this.json({}, 401);
      await this.repos.customer.delete(au.churchId, id);
      return {};
    });
  }
}
