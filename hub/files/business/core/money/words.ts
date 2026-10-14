// An amount in words for printed invoices, receipts and payments (phase 4e; ERPNext in_words). Pure functions, no
// records: the server puts the words on the print page (store/print.ts), so screens never need their own copy.
//   English: "Tanzanian Shillings One Hundred Eighteen Thousand Only", cents as "... and Fifty Cents Only".
//   Swahili: "Shilingi za Kitanzania laki moja, elfu kumi na nane tu", cents as "... na senti hamsini tu". Groups
//   (milioni, laki, elfu, mia) are parted by commas, and a last group below one hundred says "na", so 10,008
//   ("elfu kumi, na nane") never reads like 18,000 ("elfu kumi na nane").
export type Language = 'English' | 'Swahili';

const EN_ONES = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
  'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const EN_TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const EN_SCALES = ['', 'Thousand', 'Million', 'Billion', 'Trillion'];

function enBelow1000(n: number): string {
  const h = Math.floor(n / 100), r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${EN_ONES[h]} Hundred`);
  if (r) parts.push(r < 20 ? EN_ONES[r] : EN_TENS[Math.floor(r / 10)] + (r % 10 ? ` ${EN_ONES[r % 10]}` : ''));
  return parts.join(' ');
}

/** A whole number in English words: 118000 -> "One Hundred Eighteen Thousand". */
export function englishWords(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  for (let i = 0; n > 0; i++, n = Math.floor(n / 1000)) {
    const chunk = n % 1000;
    if (chunk) parts.unshift(enBelow1000(chunk) + (EN_SCALES[i] ? ` ${EN_SCALES[i]}` : ''));
  }
  return parts.join(' ');
}

const SW_ONES = ['', 'moja', 'mbili', 'tatu', 'nne', 'tano', 'sita', 'saba', 'nane', 'tisa'];
const SW_TENS = ['', 'kumi', 'ishirini', 'thelathini', 'arobaini', 'hamsini', 'sitini', 'sabini', 'themanini', 'tisini'];

function swBelow100(n: number): string {
  const t = Math.floor(n / 10), u = n % 10;
  if (!t) return SW_ONES[u];
  return SW_TENS[t] + (u ? ` na ${SW_ONES[u]}` : '');
}
function swBelow1000(n: number): string {
  const h = Math.floor(n / 100), r = n % 100;
  if (!h) return swBelow100(r);
  // 105 "mia moja na tano", 120 "mia moja na ishirini", 125 "mia moja ishirini na tano"
  return `mia ${SW_ONES[h]}` + (r ? (r < 10 || r % 10 === 0 ? ` na ${swBelow100(r)}` : ` ${swBelow100(r)}`) : '');
}

/** A whole number in Swahili words: 118000 -> "laki moja, elfu kumi na nane". */
export function swahiliWords(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'sifuri';
  const groups: { text: string; small: boolean }[] = [];
  const bil = Math.floor(n / 1e9), mil = Math.floor((n % 1e9) / 1e6), lak = Math.floor((n % 1e6) / 1e5), elf = Math.floor((n % 1e5) / 1000), rest = n % 1000;
  if (bil) groups.push({ text: `bilioni ${swahiliWords(bil)}`, small: false });
  if (mil) groups.push({ text: `milioni ${swBelow1000(mil)}`, small: false });
  if (lak) groups.push({ text: `laki ${SW_ONES[lak]}`, small: false });
  if (elf) groups.push({ text: `elfu ${swBelow100(elf)}`, small: false });
  if (rest) groups.push({ text: swBelow1000(rest), small: rest < 100 });
  return groups.map((g, i) => (i && g.small ? `na ${g.text}` : g.text)).join(', ');
}

/** An amount of money in words, with cents if any; negative amounts (returns) are said as their size. */
export function amountInWords(amount: number, language: Language = 'English'): string {
  const total = Math.round(Math.abs(Number(amount) || 0) * 100);
  const whole = Math.floor(total / 100), cents = total % 100;
  if (language === 'Swahili') return `Shilingi za Kitanzania ${swahiliWords(whole)}${cents ? ` na senti ${swahiliWords(cents)}` : ''} tu`;
  return `Tanzanian Shillings ${englishWords(whole)}${cents ? ` and ${englishWords(cents)} ${cents === 1 ? 'Cent' : 'Cents'}` : ''} Only`;
}
