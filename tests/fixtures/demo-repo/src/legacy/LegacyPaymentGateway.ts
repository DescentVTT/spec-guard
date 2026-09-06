/** Retired gateway, kept only as a negative-control fixture. */
export class LegacyPaymentGateway {
  charge(): never {
    throw new Error('LegacyPaymentGateway is retired');
  }
}
