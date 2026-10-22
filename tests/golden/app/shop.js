// COR Shop — the golden suite's own app (review follow-up). Plain JS, no build. `?release=2` is the next release:
// renamed test ids, re-ordered cards, a re-worded button, a product removed — what cor_heal is measured against.
const RELEASE = new URLSearchParams(location.search).get('release') === '2' ? 2 : 1;
const PRODUCTS = [
  { slug: 'mug', name: 'Coffee Mug', price: 12 },
  { slug: 'pen', name: 'Gel Pen', price: 3 },
  { slug: 'cap', name: 'Baseball Cap', price: 18 },
  { slug: 'tee', name: 'Logo T-Shirt', price: 22 },
];
const cart = () => JSON.parse(localStorage.getItem('cart') ?? '[]');
const saveCart = (c) => localStorage.setItem('cart', JSON.stringify(c));
const tid = (id) => (RELEASE === 2 ? id.replace(/^add-to-cart-/, 'buy-').replace(/^inventory-item$/, 'product-card') : id);
const badge = () => {
  const n = cart().length;
  const el = document.querySelector('[data-test="cart-badge"]');
  el.textContent = n ? String(n) : '';
  el.hidden = !n;
  document.querySelector('#cart-link').setAttribute('aria-label', n ? `Cart, ${n} item${n === 1 ? '' : 's'}` : 'Cart, empty');
};
const qs = (s) => document.querySelector(s);
const go = (page) => { location.href = `${page}${RELEASE === 2 ? '?release=2' : ''}`; };

window.shop = {
  login() {
    qs('#login').addEventListener('submit', (e) => {
      e.preventDefault();
      if (qs('[data-test="password"]').value === 'secret') go('inventory.html');
      else { qs('[data-test="error"]').textContent = 'Username and password do not match'; qs('[data-test="error"]').hidden = false; }
    });
  },
  inventory() {
    let products = RELEASE === 2 ? PRODUCTS.filter((p) => p.slug !== 'cap').reverse() : PRODUCTS;
    const render = () => {
      qs('[data-test="inventory-list"]').innerHTML = products.map((p) => {
        const inCart = cart().includes(p.slug);
        const label = inCart ? 'Remove' : RELEASE === 2 ? 'Add to bag' : 'Add to cart';
        const id = inCart ? `remove-${p.slug}` : tid(`add-to-cart-${p.slug}`);
        return `<li class="card" data-test="${tid('inventory-item')}">
          <h3 class="card__name" data-test="inventory-item-name">${p.name}</h3>
          <p class="card__price">$${p.price}</p>
          <button class="btn btn--primary" data-test="${id}" name="${id}">${label}</button>
        </li>`;
      }).join('');
      for (const b of document.querySelectorAll('[data-test="inventory-list"] button')) {
        b.addEventListener('click', () => {
          const slug = PRODUCTS.find((p) => p.name === b.closest('li').querySelector('h3').textContent).slug;
          const c = cart();
          saveCart(c.includes(slug) ? c.filter((s) => s !== slug) : [...c, slug]);
          render(); badge();
        });
      }
    };
    qs('[data-test="sort"]').addEventListener('change', (e) => {
      products = [...products].sort((a, b) => (e.target.value === 'price' ? a.price - b.price : a.name.localeCompare(b.name)));
      render();
    });
    if (RELEASE === 2) qs('#sort').dataset.test = 'sort-by'; // renamed in the next release; its label stays
    render(); badge();
    // A widget in a shadow root, as third-party widgets ship.
    const host = qs('#newsletter');
    host.attachShadow({ mode: 'open' }).innerHTML = '<label>Email <input type="email" name="newsletter-email"></label><button>Subscribe</button>';
  },
  cart() {
    const items = PRODUCTS.filter((p) => cart().includes(p.slug));
    qs('[data-test="cart-list"]').innerHTML = items.map((p) => `<li data-test="cart-item"><span data-test="cart-item-name">${p.name}</span> <span>$${p.price}</span> <button data-test="remove-${p.slug}">Remove</button></li>`).join('');
    for (const b of document.querySelectorAll('[data-test="cart-list"] button')) b.addEventListener('click', () => { saveCart(cart().filter((s) => `remove-${s}` !== b.dataset.test)); shop.cart(); badge(); });
    qs('[data-test="total"]').textContent = `Total: $${items.reduce((n, p) => n + p.price, 0)}`;
    qs('[data-test="checkout"]').onclick = () => go('checkout.html');
    badge();
  },
  checkout() {
    qs('#checkout').addEventListener('submit', (e) => {
      e.preventDefault();
      const missing = ['first-name', 'last-name', 'postal-code'].find((f) => !qs(`[data-test="${f}"]`).value);
      qs('[data-test="error"]').hidden = !missing;
      qs('[data-test="error"]').textContent = missing ? `Error: ${missing.replace('-', ' ')} is required` : '';
      if (!missing) { localStorage.removeItem('cart'); qs('main').innerHTML = '<h2 data-test="complete-header">Thank you for your order!</h2>'; }
    });
    badge();
  },
};
