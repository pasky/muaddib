export class RateLimiter {
  private resetTime = 0;
  private count = 0;

  constructor(
    private readonly rate = 30,
    private readonly period = 900,
    private readonly nowSeconds: () => number = () => Date.now() / 1000,
  ) {}

  checkLimit(): boolean {
    if (this.rate <= 0) {
      return true;
    }

    const now = this.nowSeconds();
    if (now >= this.resetTime) {
      this.resetTime = now + this.period;
      this.count = 0;
    }

    if (this.count >= this.rate) {
      return false;
    }

    this.count += 1;
    return true;
  }
}
