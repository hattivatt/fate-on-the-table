/**
 * menu.js — общий модуль контекстных меню (объединение FatePointManager.openModuleMenu
 * и ConflictInteractions.showMenu).
 *
 * Единственная публичная функция `showCttMenu({ items, event, point, menuClass? })`
 * рендерит .ctt-меню в document.body:
 *  - point имеет приоритет (конвертация world→client через canvas.stage.worldTransform),
 *    иначе event.clientX/Y, иначе 0/0;
 *  - флип у краёв окна: Math.min(x, innerWidth - rect.width - 8) (объединённая логика обеих реализаций);
 *  - закрытие по Escape / outside pointerdown (capture) / scroll / resize — надмножество поведения обеих.
 *
 * Форма элемента: { icon, label, disabled?, sep?, onClick, children?: array }
 *  - children — массив таких же items; пункт с children открывает вложенное меню
 *    справа от пункта (при нехватке места — слева; вертикально флип у краёв).
 *    Закрытие вложенного: mouseleave с delay ~250мс, клик вне, закрытие родителя.
 *    Клик по пункту с children не закрывает меню и не выполняет onClick.
 * label/icon уже экранируются через escapeHtml.
 * Поддерживает disabled, sep, кликабельность 1:1.
 * Не использует top-level foundry — только DOM.
 */

import { escapeHtml } from "./utils.js";

let activeMenu = null;
const activeSubmenus = [];
const submenuCloseTimers = new Map();

function clientPosition(event, point) {
  // point имеет приоритет (мир→клиент)
  if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
    try {
      if (
        typeof canvas !== "undefined" &&
        canvas?.app?.view &&
        canvas?.stage?.worldTransform &&
        typeof PIXI !== "undefined" &&
        PIXI?.Point
      ) {
        const p = canvas.stage.worldTransform.apply(new PIXI.Point(point.x, point.y));
        const rect = canvas.app.view.getBoundingClientRect();
        if (
          Number.isFinite(p.x) &&
          Number.isFinite(p.y) &&
          Number.isFinite(rect.left) &&
          Number.isFinite(rect.top)
        ) {
          return { x: rect.left + p.x, y: rect.top + p.y };
        }
      }
    } catch {
      // fallback к event
    }
  }
  if (Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)) {
    return { x: event.clientX, y: event.clientY };
  }
  return { x: 0, y: 0 };
}

export function showCttMenu({ items, event, point, menuClass } = {}) {
  closeCttMenu();
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return null;
  const menu = document.createElement("div");
  menu.className = menuClass || "ctt-menu";
  renderLevel(menu, list, menuClass || "ctt-menu");
  if (!menu.childElementCount) return null;
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  const pos = clientPosition(event, point);
  menu.style.left = `${Math.min(pos.x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(pos.y, window.innerHeight - rect.height - 8)}px`;
  activeMenu = menu;
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("scroll", closeCttMenu, true);
  window.addEventListener("resize", closeCttMenu);
  return menu;
}

function renderLevel(menuEl, items, menuClass) {
  menuEl.__submenus = [];
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    if (item.sep) {
      btn.classList.add("ctt-menu-sep", "ctt-conflict-menu-sep");
    }
    if (item.disabled) btn.disabled = true;
    const hasChildren = Array.isArray(item.children) && item.children.length > 0;
    const canOpen = hasChildren && !item.disabled;
    if (canOpen) {
      btn.innerHTML = `<i class="fas ${escapeHtml(item.icon ?? "")}"></i> ${escapeHtml(item.label ?? "")} <i class="fas fa-chevron-right" style="float:right;margin-left:8px;opacity:0.6"></i>`;
    } else {
      btn.innerHTML = `<i class="fas ${escapeHtml(item.icon ?? "")}"></i> ${escapeHtml(item.label ?? "")}`;
    }
    if (canOpen) {
      let submenu = null;
      const open = () => {
        for (const sib of [...(menuEl.__submenus ?? [])]) {
          if (sib !== submenu && sib.isConnected) closeSubmenu(sib);
        }
        if (submenu?.isConnected) {
          positionSubmenu(submenu, btn);
          return submenu;
        }
        submenu = document.createElement("div");
        submenu.className = menuClass || "ctt-menu";
        // ensure fixed positioning like root (css .ctt-menu already does)
        submenu.classList.add("ctt-submenu");
        renderLevel(submenu, item.children, menuClass);
        document.body.append(submenu);
        menuEl.__submenus.push(submenu);
        activeSubmenus.push(submenu);
        positionSubmenu(submenu, btn);
        submenu.addEventListener("mouseenter", () => clearCloseTimer(submenu));
        submenu.addEventListener("mouseleave", () => scheduleClose(submenu, btn));
        return submenu;
      };
      btn.addEventListener("mouseenter", () => {
        clearCloseTimer(submenu);
        open();
      });
      btn.addEventListener("mouseleave", () => {
        if (submenu?.isConnected) scheduleClose(submenu, btn);
      });
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (submenu?.isConnected) {
          closeSubmenu(submenu);
          submenu = null;
        } else {
          open();
        }
      });
    } else {
      btn.addEventListener("click", () => {
        closeCttMenu();
        if (!item.disabled && typeof item.onClick === "function") {
          Promise.resolve(item.onClick()).catch((err) =>
            console.error("[fate-on-the-table] menu action failed:", err),
          );
        }
      });
    }
    menuEl.append(btn);
  }
}

function clearCloseTimer(submenu) {
  if (!submenu) return;
  const id = submenuCloseTimers.get(submenu);
  if (id != null) {
    clearTimeout(id);
    submenuCloseTimers.delete(submenu);
  }
}

function scheduleClose(submenu, anchorBtn) {
  if (!submenu?.isConnected) return;
  clearCloseTimer(submenu);
  const id = setTimeout(() => {
    submenuCloseTimers.delete(submenu);
    closeSubmenu(submenu);
  }, 250);
  submenuCloseTimers.set(submenu, id);
}

function closeSubmenu(submenu) {
  if (!submenu) return;
  clearCloseTimer(submenu);
  for (const child of [...(submenu.__submenus ?? [])]) {
    closeSubmenu(child);
  }
  submenu.__submenus = [];
  const idx = activeSubmenus.indexOf(submenu);
  if (idx >= 0) activeSubmenus.splice(idx, 1);
  // remove from parent __submenus if present
  // parent tracking is via menuEl.__submenus; we already removed from activeSubmenus,
  // but keep parent array clean for sibling logic
  try {
    submenu.remove();
  } catch {
    // ignore
  }
}

function positionSubmenu(submenu, anchorBtn) {
  const anchorRect = anchorBtn.getBoundingClientRect();
  const subRect = submenu.getBoundingClientRect();
  let x = anchorRect.right + 4;
  if (x + subRect.width > window.innerWidth - 8) {
    x = anchorRect.left - subRect.width - 4;
  }
  if (x < 8) x = 8;
  if (x + subRect.width > window.innerWidth - 8) {
    x = Math.max(8, window.innerWidth - subRect.width - 8);
  }
  let y = anchorRect.top;
  if (y + subRect.height > window.innerHeight - 8) {
    y = window.innerHeight - subRect.height - 8;
  }
  if (y < 8) y = 8;
  submenu.style.left = `${x}px`;
  submenu.style.top = `${y}px`;
}

export function closeCttMenu() {
  for (const [sub, id] of submenuCloseTimers) clearTimeout(id);
  submenuCloseTimers.clear();
  for (const sub of [...activeSubmenus]) {
    try {
      sub.remove();
    } catch {
      // ignore
    }
  }
  activeSubmenus.length = 0;
  if (!activeMenu) return;
  // also clear any nested submenus referenced from root
  for (const child of [...(activeMenu.__submenus ?? [])]) {
    closeSubmenu(child);
  }
  try {
    activeMenu.remove();
  } catch {
    // ignore
  }
  activeMenu = null;
  window.removeEventListener("pointerdown", onPointerDown, true);
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("scroll", closeCttMenu, true);
  window.removeEventListener("resize", closeCttMenu);
}

// Совместимость: прежние имена
export const closeMenu = closeCttMenu;

export function getActiveMenu() {
  return activeMenu;
}

export function isCttMenuOpen() {
  return !!activeMenu;
}

function onPointerDown(event) {
  if (!activeMenu) return;
  if (activeMenu.contains(event.target)) return;
  if (activeSubmenus.some((s) => s.contains(event.target))) return;
  closeCttMenu();
}

function onKeyDown(event) {
  if (event.key === "Escape") closeCttMenu();
}
