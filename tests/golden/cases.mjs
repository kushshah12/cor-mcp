// U1 — golden cases. Each opens a frozen site (sites/<id>/page.html) or a fixture (fixtures/<name>.html),
// makes its calls, and records every reply in expected/<id>.txt. `defect` names the live defect a case
// pins (D1–D7, origin doc); its recorded output is today's, wrong on purpose, so the fix shows as a diff.
// Elements are named by selector, not ref, so a case does not depend on snapshot numbering.
const ADD_BACKPACK = '[data-test="add-to-cart-sauce-labs-backpack"]';

export const CASES = [
  // ── saucedemo login ──
  { id: 'sd-login-username-pw', open: 'site/saucedemo-login', calls: [['cor_inspect', { selector: '[data-test="username"]' }]], defect: 'D5' },
  { id: 'sd-login-button-pw', open: 'site/saucedemo-login', calls: [['cor_inspect', { selector: '[data-test="login-button"]' }]] },
  { id: 'sd-login-button-wdio', open: 'site/saucedemo-login', calls: [['cor_inspect', { selector: '[data-test="login-button"]', framework: 'webdriverio' }]] },
  { id: 'sd-login-button-cy', open: 'site/saucedemo-login', calls: [['cor_inspect', { selector: '[data-test="login-button"]', framework: 'cypress' }]] },
  { id: 'sd-login-fill', open: 'site/saucedemo-login', calls: [['cor_fill', { target: '[data-test="username"]', value: 'standard_user' }]], defect: 'D5' },

  // ── saucedemo inventory ──
  { id: 'sd-inv-add-pw', open: 'site/saucedemo-inventory', calls: [['cor_inspect', { selector: ADD_BACKPACK }]], defect: 'D1' },
  { id: 'sd-inv-add-wdio', open: 'site/saucedemo-inventory', calls: [['cor_inspect', { selector: ADD_BACKPACK, framework: 'webdriverio' }]], defect: 'D1 D4' },
  { id: 'sd-inv-add-cy', open: 'site/saucedemo-inventory', calls: [['cor_inspect', { selector: ADD_BACKPACK, framework: 'cypress' }]], defect: 'D1 D4' },
  { id: 'sd-inv-sort-pw', open: 'site/saucedemo-inventory', calls: [['cor_inspect', { selector: '[data-test="product-sort-container"]' }]] },
  { id: 'sd-inv-badge-target-pw', open: 'site/saucedemo-inventory', calls: [['cor_inspect', { selector: '[data-test="shopping-cart-link"]' }]] },
  {
    id: 'sd-inv-framework-sticks', open: 'site/saucedemo-inventory', defect: 'D3',
    calls: [['cor_inspect', { selector: '[data-test="product-sort-container"]', framework: 'cypress' }], ['cor_inspect', { selector: '[data-test="product-sort-container"]' }]],
  },
  { id: 'sd-grade-first', open: 'site/saucedemo-inventory', calls: [['cor_grade', { selector: "page.getByRole('button', { name: 'Add to cart' }).first()" }]], defect: 'D2' },
  { id: 'sd-grade-nth-bare-tag', open: 'site/saucedemo-inventory', calls: [['cor_grade', { selector: "page.locator('.inventory_item').nth(0).locator('button')" }]] },
  {
    id: 'sd-grade-param-name', open: 'site/saucedemo-inventory', defect: 'D6',
    calls: [['cor_grade', { selector: "page.locator('[data-test=\"inventory-item\"]').filter({ has: page.getByText(name, { exact: true }) }).getByRole('button', { name: 'Add to cart' })", param: 'name' }]],
  },
  {
    id: 'sd-grade-param-title', open: 'site/saucedemo-inventory',
    calls: [['cor_grade', { selector: "page.locator('[data-test=\"inventory-item\"]').filter({ has: page.getByText(title, { exact: true }) }).getByRole('button', { name: 'Add to cart' })", param: 'title' }]],
  },
  { id: 'sd-grade-testid', open: 'site/saucedemo-inventory', calls: [['cor_grade', { selector: "page.getByTestId('inventory-item')" }]], defect: 'D7' },
  // U3: a Playwright project whose config sets testIdAttribute: 'data-test'.
  { id: 'sd-grade-testid-configured', project: 'pw-data-test', open: 'site/saucedemo-inventory', calls: [['cor_grade', { selector: "page.getByTestId('shopping-cart-link')" }], ['cor_inspect', { selector: '[data-test="shopping-cart-link"]' }]] },

  // ── bstackdemo ──
  { id: 'bs-buy-pw', open: 'site/bstackdemo', calls: [['cor_inspect', { selector: '.shelf-item:nth-child(2) .shelf-item__buy-btn' }]] },
  { id: 'bs-buy-cy', open: 'site/bstackdemo', calls: [['cor_inspect', { selector: '.shelf-item:nth-child(2) .shelf-item__buy-btn', framework: 'cypress' }]] },
  { id: 'bs-signin-pw', open: 'site/bstackdemo', calls: [['cor_inspect', { selector: '#signin' }]] },

  // ── fixtures: the hard shapes ──
  { id: 'fx-cards-choose-pw', open: 'fixture/cards', calls: [['cor_inspect', { selector: '.card:nth-child(2) > button' }]] },
  { id: 'fx-pricing-choose-pw', open: 'fixture/pricing', calls: [['cor_snapshot', {}]] },
  { id: 'fx-tables-snapshot', open: 'fixture/tables', calls: [['cor_snapshot', {}]] },
  { id: 'fx-faq-snapshot', open: 'fixture/faq', calls: [['cor_snapshot', {}]] },
  { id: 'fx-traps-snapshot', open: 'fixture/traps', calls: [['cor_snapshot', {}]] },
];
