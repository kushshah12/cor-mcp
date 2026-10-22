// One case per idiom-table shape (spec §10): a fixture page, the element to inspect, and what the renderer is expected to say.
// `idioms` are the ones the rendered helper must use; `none` marks a page the renderer must decline.
export const CASES = [
  { id: 'attribute', fixture: 'p3a-attribute.html', target: '[data-testid="sku-beta"] button', idioms: ['item.attribute', 'leaf.aria'], cy: ['item.attribute', 'leaf.css'] },
  { id: 'label', fixture: 'p3a-label.html', target: '.faq:nth-child(2) .faq__q', idioms: ['item.label', 'leaf.css'], cy: ['item.label', 'leaf.css'] },
  { id: 'either', fixture: 'p3a-either.html', target: '.grid .plan:nth-child(2) button', idioms: ['item.either', 'leaf.aria.shown', 'variant.click'], toggled: 'input[type=radio]', cy: ['item.either', 'leaf.css.shown', 'variant.click'] },
  { id: 'twin-toggle', fixture: 'p3a-either.html', target: '.grid .plan:nth-child(1) button:not([hidden])', idioms: ['item.either', 'leaf.aria.shown'], cy: ['item.either', 'leaf.css.shown'] },
  { id: 'twin', fixture: 'p3a-twin.html', target: '.card:nth-child(2) .primary', idioms: ['item.label', 'leaf.aria.shown'], not: ['leaf.aria', 'leaf.css'], cy: ['item.label', 'leaf.css.shown'] },
  { id: 'clash', fixture: 'p3a-heading-clash.html', target: '.card:nth-child(2) button', idioms: ['item.attribute', 'leaf.css'], not: ['leaf.aria', 'leaf.aria.shown'], cy: ['item.attribute', 'leaf.css'] },
  { id: 'group-hidden', fixture: 'p3a-groups.html', target: 'input[value="individuals"]', idioms: ['group.label-input', 'group.label-click'], select: true, cy: ['group.label', 'group.label-click'] },
  // P2a fix: display: none inputs (BrowserStack) are outside the accessibility tree — aria/ never finds them.
  { id: 'group-hidden-none', fixture: 'p3a-groups-none.html', target: 'input[value="individuals"]', idioms: ['group.label-input', 'group.label-click'], select: true, cy: ['group.label', 'group.label-click'] },
  { id: 'group-tabs', fixture: 'p3a-groups.html', target: 'button[role=tab]:nth-of-type(2)', idioms: ['group.aria'], cy: ['group.role'] },
  { id: 'group-visible', fixture: 'p3b-groups-visible.html', target: 'input[value="m"]', idioms: ['group.aria'], cy: ['group.label'] },
  { id: 'cell', fixture: 'p3a-compare.html', target: 'div[data-product-id="live"] table:nth-of-type(3) tr:nth-child(2) td:nth-child(4)', idioms: ['cell.xpath'] },
  { id: 'cell-users', fixture: 'p3b-tables.html', target: 'table.users tbody tr:nth-child(2) td:nth-child(2)', idioms: ['cell.xpath'], cy: ['cell.css'] },
  { id: 'cell-picks', fixture: 'p3b-tables.html', target: 'table.picks tr:nth-child(2) td:nth-child(3)', idioms: ['cell.xpath'], cy: ['cell.css'] },
  { id: 'cell-copies', fixture: 'p3b-tables-copies.html', target: 'div[data-product="live"] tbody tr:nth-child(2) td:nth-child(2)', idioms: ['cell.xpath'], cy: ['cell.css'] },
  // P3: a per-card text leaf with a hidden twin first in one card, and a card that has no such leaf.
  { id: 'p3-card-price', fixture: 'p3-card-price.html', target: '.card:nth-child(2) .card__price', idioms: ['item.either', 'leaf.css.shown'], not: ['leaf.css'], cy: ['item.either', 'leaf.css.shown'] },
  // P3 (run b14ddae4): the card's name, an h3 on one card and a toggle label on another — from either element.
  { id: 'p3-card-name-h3', fixture: 'p3-card-price.html', target: '.card:nth-child(2) h3', idioms: ['item.either', 'leaf.name'], cy: ['item.either', 'leaf.name'] },
  { id: 'p3-card-name-label', fixture: 'p3-card-price.html', target: 'label[for=t2]', idioms: ['item.either', 'leaf.name'], cy: ['item.either', 'leaf.name'] },
  // P3 (run b14ddae4): an image as a cell's content — cells without it find nothing in every framework.
  { id: 'p3-cell-image', fixture: 'p3-cell-image.html', target: 'tr:nth-child(2) td:nth-child(3) img', idioms: ['cell.xpath'], cy: ['cell.css'] },
  // P3: BrowserStack's long scoped table XPath — a selector constant over 120 characters still gets a WebdriverIO helper.
  { id: 'p3-cell-long', fixture: 'p3-cell-long.html', target: 'div[data-plan-type="teams"] tr:nth-child(2) td:nth-child(2)', idioms: ['cell.xpath'], cy: ['cell.css'] },
  { id: 'p3-cell-long-img', fixture: 'p3-cell-long.html', target: 'div[data-plan-type="teams"] tr:nth-child(2) td:nth-child(3) img', idioms: ['cell.xpath'], cy: ['cell.css'] },
  // P3: names held inside their cells (a span beside a tooltip; an h3 or a toggle label) — Cypress finds them by the holder.
  { id: 'p3-cell-holder', fixture: 'p3-cell-holder.html', target: 'div[data-plan-type="teams"] tr:nth-child(2) td:nth-child(4)', idioms: ['cell.xpath'], cy: ['cell.css'] },
  { id: 'p3-cell-holder-img', fixture: 'p3-cell-holder.html', target: 'div[data-plan-type="teams"] tr:nth-child(3) td:nth-child(3) img', idioms: ['cell.xpath'], cy: ['cell.css'] },
  { id: 'transformed', fixture: 'p3a-transformed.html', target: '.row:nth-child(1) button', none: /text-transform/ },
  // U10: the U6 shapes — a test-attribute item scope and name slot, a per-item test-id leaf — on frozen saucedemo and a fixture.
  { id: 'u10-saucedemo-add', fixture: 'u10-saucedemo-inventory.html', target: '[data-test="add-to-cart-sauce-labs-backpack"]', idioms: ['item.label.attr', 'leaf.aria'], cy: ['item.label', 'leaf.css'] },
  // P6: <input type="submit" value="Choose"> per card (BrowserStack's shape) — named by value; WebdriverIO's aria/ finds it.
  { id: 'p6-submit-input', fixture: 'p6-submit-input.html', target: '.card:nth-child(2) input', idioms: ['leaf.aria'], cy: ['leaf.css'] },
  { id: 'u10-prefix-leaf', fixture: 'u10-slots.html', target: '[data-test="add-to-basket-pen"]', idioms: ['item.label', 'leaf.aria'], cy: ['item.label', 'leaf.css'] },
];
