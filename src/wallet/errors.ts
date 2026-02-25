export class OorLimitExceededError extends Error {
  constructor(
    public readonly requestedSats: number,
    public readonly limitSats: number,
    public readonly totalBalance: number,
  ) {
    super(
      `OOR limit exceeded: requested ${requestedSats} sats, limit is ${limitSats} sats ` +
      `(max of ${totalBalance > 0 ? Math.round(limitSats / totalBalance * 100) : 0}% of ${totalBalance} total, or min floor)`
    );
    this.name = 'OorLimitExceededError';
  }
}
