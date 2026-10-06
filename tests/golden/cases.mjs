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

  // U10: in a project that declares the framework's major, a conformance-run idiom is labelled as run, not emulated.
  { id: 'sd-inv-add-wdio9', project: 'wdio9', open: 'site/saucedemo-inventory', calls: [['cor_inspect', { selector: ADD_BACKPACK }]] },
  { id: 'sd-inv-add-cy16', project: 'cy16', open: 'site/saucedemo-inventory', calls: [['cor_inspect', { selector: ADD_BACKPACK }]] },

  // U11: one authoring path, end to end — its total characters are the figure to compare with Playwright MCP's
  // inventory snapshot (5,500 characters live on 2026-10-05; the agent needs that snapshot before every locator).
  {
    id: 'sd-authoring-path', project: 'pw-data-test', open: 'site/saucedemo-inventory',
    calls: [['cor_snapshot', {}], ['cor_inspect', { selector: ADD_BACKPACK }], ['cor_inspect', { selector: '[data-test="shopping-cart-link"]' }]],
  },

  // ── bstackdemo ──
  { id: 'bs-buy-pw', open: 'site/bstackdemo', calls: [['cor_inspect', { selector: '[id="2"] .shelf-item__buy-btn' }]] },
  { id: 'bs-buy-cy', open: 'site/bstackdemo', calls: [['cor_inspect', { selector: '[id="2"] .shelf-item__buy-btn', framework: 'cypress' }]] },
  { id: 'bs-signin-pw', open: 'site/bstackdemo', calls: [['cor_inspect', { selector: '#signin' }]] },

  // ── fixtures: the hard shapes ──
  { id: 'fx-cards-choose-pw', open: 'fixture/cards', calls: [['cor_inspect', { selector: '.card:nth-child(2) > button' }]] },
  { id: 'fx-pricing-choose-pw', open: 'fixture/pricing', calls: [['cor_snapshot', {}]] },
  { id: 'fx-tables-snapshot', open: 'fixture/tables', calls: [['cor_snapshot', {}]] },
  { id: 'fx-faq-snapshot', open: 'fixture/faq', calls: [['cor_snapshot', {}]] },
  { id: 'fx-traps-snapshot', open: 'fixture/traps', calls: [['cor_snapshot', {}]] },

  // ── P4: the default cor_inspect reply — the answer and its code, about 6 lines ──
  { id: 'p4-brief-template-pw', open: 'site/saucedemo-inventory', calls: [['cor_inspect', { selector: ADD_BACKPACK, detail: false }]] },
  { id: 'p4-brief-single-cy', project: 'cy16', open: 'site/saucedemo-login', calls: [['cor_inspect', { selector: '[data-test="login-button"]', detail: false }]] },
  { id: 'p4-brief-hidden-wdio', project: 'wdio9', open: 'fixture/toggles', calls: [['cor_inspect', { selector: '#annual', detail: false }]] },
  { id: 'p4-brief-declined-pw', open: 'fixture/p1-no-durable', calls: [['cor_inspect', { selector: '.list > div:nth-child(2) .dot', detail: false }]] },

  // ── P3 class page: a price anchored on a parent's data-* (the engine takes the ancestor name that narrows most) ──
  { id: 'p3-parent-attr-pw', open: 'fixture/p3-parent-attr', calls: [['cor_inspect', { selector: '[data-plan-key=team] .price-amount', detail: false }]] },

  // ── P1 class pages: one per bug class, each entry must pass the shared positional / structural check ──
  { id: 'p1-split-header-cy', project: 'cy16', open: 'fixture/p1-split-header', calls: [['cor_inspect', { selector: 'table.body tr:nth-child(2) td:nth-child(3)' }]] },
  { id: 'p1-split-header-pw', open: 'fixture/p1-split-header', calls: [['cor_inspect', { selector: 'table.body tr:nth-child(2) td:nth-child(3)' }]] },
  { id: 'p1-nested-heading-cy', project: 'cy16', open: 'fixture/p1-nested-heading', calls: [['cor_inspect', { selector: '#checkout-root h3' }]] },
  { id: 'p1-no-durable-cy', project: 'cy16', open: 'fixture/p1-no-durable', calls: [['cor_inspect', { selector: '.list > div:nth-child(2) .dot' }]] },
  { id: 'p1-xpath-only-cy', project: 'cy16', open: 'fixture/p1-xpath-only', calls: [['cor_inspect', { selector: 'div[data-product-id="live"] table:nth-of-type(3) tr:nth-child(2) td:nth-child(4)' }]] },

  // ── COR Shop (app/): the suite's own app, with JS. One case per hard shape, plus cor_check and cor_heal end to end. ──
  {
    id: 'shop-login-flow', project: 'shop-repo', open: 'app/login.html',
    calls: [
      ['cor_inspect', { selector: '[data-test="login-button"]' }],
      ['cor_fill', { target: '[data-test="username"]', value: 'standard' }],
      ['cor_fill', { target: '[data-test="password"]', value: 'wrong' }],
      ['cor_click', { target: '[data-test="login-button"]' }],
      ['cor_inspect', { selector: '[data-test="error"]' }],
      ['cor_fill', { target: '[data-test="password"]', value: 'secret' }],
      ['cor_click', { target: '[data-test="login-button"]' }],
    ],
  },
  {
    id: 'shop-add-remove-state', project: 'shop-repo', open: 'app/inventory.html',
    calls: [
      ['cor_inspect', { selector: '[data-test="add-to-cart-pen"]' }],
      ['cor_click', { target: '[data-test="add-to-cart-pen"]' }],
      ['cor_inspect', { selector: '[data-test="remove-pen"]' }],
      ['cor_inspect', { selector: '#cart-link' }],
    ],
  },
  { id: 'shop-featured-no-testids', project: 'shop-repo', open: 'app/inventory.html', calls: [['cor_inspect', { selector: '.tile:nth-child(2) .tile__go' }]] },
  { id: 'shop-orders-cell', project: 'shop-repo', open: 'app/inventory.html', calls: [['cor_snapshot', { within: 'A-1002' }], ['cor_inspect', { selector: 'table.orders tbody tr:nth-child(2) td:nth-child(2)' }]] },
  { id: 'shop-shadow-widget', project: 'shop-repo', open: 'app/inventory.html', calls: [['cor_inspect', { selector: '#newsletter >>> button' }]] },
  { id: 'shop-sort-cypress', project: 'shop-repo', open: 'app/inventory.html', calls: [['cor_inspect', { selector: '[data-test="sort"]', framework: 'cypress' }], ['cor_inspect', { selector: '[data-test="sort"]', framework: 'webdriverio' }]] },
  {
    id: 'shop-checkout-form', project: 'shop-repo', open: 'app/checkout.html',
    calls: [['cor_inspect', { selector: '[data-test="postal-code"]' }], ['cor_click', { target: '[data-test="continue"]' }]],
  },
  {
    // cor_check over the fixture repo: an entry placed as issued passes; its id copied onto another locator, a typed
    // .first(), an id from another project fail; Testing Library's screen query in a component test is not scanned.
    id: 'shop-cor-check', project: 'shop-repo', records: true, open: 'app/inventory.html',
    calls: [['cor_inspect', { selector: '[data-test="sort"]' }], ['cor_check', { all: true }]],
  },
  {
    // cor_heal across a release (?release=2): the sort select's test id renamed (label kept) heals from a stored
    // locator; the Pen button, renamed AND re-worded, and the removed Cap are declined — never healed onto a sibling.
    id: 'shop-cor-heal-release', project: 'shop-repo', records: true, open: 'app/inventory.html',
    calls: [
      ['cor_inspect', { selector: '[data-test="sort"]' }],
      ['cor_inspect', { selector: '[data-test="add-to-cart-pen"]' }],
      ['cor_inspect', { selector: '[data-test="add-to-cart-cap"]' }],
      ['cor_open', { url: '{base}/app/inventory.html?release=2' }],
      ['cor_heal', { id: '000001' }],
      ['cor_heal', { id: '000002' }],
      ['cor_heal', { id: '000004' }], // P3: 000003 is the items' every-item locator, shared by the Pen and the Cap
      ['cor_heal', { id: '000003' }],
    ],
  },
];
