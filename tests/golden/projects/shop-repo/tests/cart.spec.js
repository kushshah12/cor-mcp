import { test, expect } from '@playwright/test';
import { InventoryPage } from './pages/inventory.page.js';

test('adds the first product', async ({ page }) => {
  await page.goto('/inventory.html');
  await page.locator('.card button').first().click();
  // COR cor:abcdef · from another project
  await expect(page.locator('[data-test="cart-badge"]')).toHaveText('1');
});
