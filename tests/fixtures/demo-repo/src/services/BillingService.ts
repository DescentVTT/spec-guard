export class BillingService {
  async charge(amount: number): Promise<string> {
    return 'receipt-' + amount;
  }
}
