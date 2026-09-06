import { BillingService } from '../services/BillingService.js';

/** Entry point for the modern payment flow. */
export class PaymentController {
  constructor(private readonly billing: BillingService) {}

  async charge(amount: number): Promise<string> {
    return this.billing.charge(amount);
  }
}
