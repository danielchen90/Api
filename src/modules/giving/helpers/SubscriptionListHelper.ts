import { GatewayService } from "../../../shared/helpers/GatewayService.js";

/**
 * The recurring gifts of one customer across every gateway that supports subscriptions
 * (moved out of CustomerController so GET /giving/subscriptions/my can share it). Stripe rows are
 * passed through; Kingdom Funding schedules are normalized to the Stripe-like shape the UI expects.
 */
export class SubscriptionListHelper {
  public static async load(repos: any, churchId: string, customerId: string, personId: string): Promise<any[]> {
    // Load all gateways and fetch subscriptions from each that supports them
    const allGateways = (await repos.gateway.loadAll(churchId)) as any[];
    const allSubscriptions: any[] = [];

    // If no gateways are configured, return empty array (church hasn't set up giving)
    if (!allGateways || allGateways.length === 0) {
      console.warn(`getSubscriptions: no gateways configured for churchId=${churchId}`);
      return [];
    }

    for (const gw of allGateways) {
      const capabilities = GatewayService.getProviderCapabilities(gw);
      if (!capabilities?.supportsSubscriptions) continue;

      try {
        // Find the correct customer ID for this specific gateway/provider
        let gatewayCustomerId = customerId; // default to the passed-in ID (works for Stripe)
        if (gw.provider?.toLowerCase() !== "stripe") {
          const providerCustomer = await repos.customer.loadByPersonAndProvider(churchId, personId, gw.provider) as any;
          if (!providerCustomer) continue; // no customer on this provider, skip
          gatewayCustomerId = providerCustomer.id;
        }

        const gateway = await GatewayService.getGatewayForChurch(churchId, { gatewayId: gw.id }, repos.gateway);

        let result: any;
        try {
          result = await GatewayService.getCustomerSubscriptions(gateway, gatewayCustomerId);
        } catch (subErr: any) {
          // Customer doesn't exist on the provider — skip this gateway
          if (subErr.response?.status === 404) {
            console.warn(`Customer ${gatewayCustomerId} not found on ${gw.provider} for subscriptions, skipping.`);
            continue;
          }
          throw subErr;
        }

        // Handle Stripe format ({ data: [...] }) and KF format (array)
        const subs = Array.isArray(result) ? result : (result?.data || []);

        for (const sub of subs) {
          const providerName = gw.provider?.toLowerCase();

          if (providerName === "kingdomfunding") {
            // The provider marks cancelled/expired schedules active:false — skip those.
            if (!sub.active) continue;

            // Normalize the NMI recurring schedule to the Stripe-like shape the UI expects.
            // Use next_run_date so the "Start Date" column shows the next charge date.
            const amountCents = Math.round((sub.amount || 0) * 100);
            const anchorSrc = sub.next_run_date || sub.created_at;
            const freq = SubscriptionListHelper.mapKFFrequency(sub.frequency);
            allSubscriptions.push({
              id: String(sub.id),
              status: "active",
              billing_cycle_anchor: anchorSrc
                ? Math.floor(new Date(anchorSrc).getTime() / 1000)
                : Math.floor(Date.now() / 1000),
              default_payment_method: sub.payment_method_id ? String(sub.payment_method_id) : undefined,
              plan: {
                amount: amountCents,
                interval: freq.interval,
                interval_count: freq.interval_count
              },
              provider: providerName,
              gatewayId: gw.id
            });
          } else {
            allSubscriptions.push({ ...sub, provider: providerName, gatewayId: gw.id });
          }
        }
      } catch (e) {
        console.warn(`Failed to load subscriptions from ${gw.provider}:`, e);
      }
    }

    return allSubscriptions;
  }

  public static mapKFFrequency(frequency: string): { interval: string; interval_count: number } {
    switch (frequency?.toLowerCase()) {
      case "daily": return { interval: "day", interval_count: 1 };
      case "weekly": return { interval: "week", interval_count: 1 };
      case "biweekly": return { interval: "week", interval_count: 2 };
      case "monthly": return { interval: "month", interval_count: 1 };
      case "bimonthly": return { interval: "month", interval_count: 2 };
      case "quarterly": return { interval: "month", interval_count: 3 };
      case "biannually": return { interval: "month", interval_count: 6 };
      case "annually": return { interval: "year", interval_count: 1 };
      default: return { interval: "month", interval_count: 1 };
    }
  }
}
