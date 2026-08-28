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
 * Форма элемента: { icon, label, disabled?, sep?, onClick }
 * label/icon уже экранируются через escapeHtml.
 * Поддерживает disabled, sep, кликабельность 1:1.
 * Не использует top-level foundry — только DOM.
 */

import { escapeHtml } from "./utils.js";

let activeMenu = null;

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
  for (const item of list) {
    const btn = document.createElement("button");
    btn.type = "button";
    if (item.sep) {
      btn.classList.add("ctt-menu-sep", "ctt-conflict-menu-sep");
    }
    if (item.disabled) btn.disabled = true;
    btn.innerHTML = `<i class="fas ${escapeHtml(item.icon ?? "")}"></i> ${escapeHtml(item.label ?? "")}`;
    btn.addEventListener("click", () => {
      closeCttMenu();
      if (!item.disabled && typeof item.onClick === "function") {
        Promise.resolve(item.onClick()).catch((err) =>
          console.error("[fate-on-the-table] menu action failed:", err),
        );
      }
    });
    menu.append(btn);
  }
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

export function closeCttMenu() {
  if (!activeMenu) return;
  activeMenu.remove();
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
  closeCttMenu();
}

function onKeyDown(event) {
  if (event.key === "Escape") closeCttMenu();
}
