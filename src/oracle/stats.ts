// Statistics for the oracles. Distribution functions follow Press et al., Numerical Recipes 3rd ed.
// (§6.2 incomplete gamma by series / continued fraction, §6.2.2 erfc), in f64.

export function lnGamma(x: number): number {
  // Lanczos approximation, g = 7, n = 9 (NR §6.1).
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularized upper incomplete gamma Q(a, x). */
export function gammaQ(a: number, x: number): number {
  if (x < 0 || a <= 0) throw new RangeError("gammaQ domain");
  if (x === 0) return 1;
  const gln = lnGamma(a);
  if (x < a + 1) {
    let sum = 1 / a;
    let del = sum;
    for (let n = 1; n < 10000; n++) {
      del *= x / (a + n);
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  const FPMIN = 1e-300;
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 10000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

/** Upper-tail p-value of a chi-square statistic with df degrees of freedom. */
export function chiSquareP(stat: number, df: number): number {
  return gammaQ(df / 2, stat / 2);
}

/** Pearson chi-square of observed vs expected counts, merging bins with expected < 5 (Cochran). */
export function chiSquare(observed: ArrayLike<number>, expected: ArrayLike<number>): { stat: number; df: number; p: number } {
  let stat = 0;
  let bins = 0;
  let accO = 0;
  let accE = 0;
  for (let i = 0; i < observed.length; i++) {
    accO += observed[i]!;
    accE += expected[i]!;
    if (accE >= 5) {
      stat += ((accO - accE) * (accO - accE)) / accE;
      bins++;
      accO = 0;
      accE = 0;
    }
  }
  if (accE > 0) {
    stat += ((accO - accE) * (accO - accE)) / accE;
    bins++;
  }
  const df = bins - 1;
  return { stat, df, p: chiSquareP(stat, df) };
}

/** Ordinary least squares slope and intercept of y on x. */
export function olsSlope(x: number[], y: number[]): { slope: number; intercept: number } {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i]! - mx) * (y[i]! - my);
    sxx += (x[i]! - mx) ** 2;
  }
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

export function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - ma;
    const db = b[i]! - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return sab / Math.sqrt(saa * sbb);
}
