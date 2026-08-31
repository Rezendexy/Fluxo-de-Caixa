(function (global) {
  "use strict";

  var backdrop, titleEl, msgEl, cancelBtn, confirmBtn, lastFocus;
  var resolver = null;

  function ensure() {
    if (backdrop) return;
    backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    backdrop.innerHTML =
      '<div class="dialog card" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-msg">' +
      '<p class="dialog__title" id="dialog-title"></p>' +
      '<p class="dialog__msg" id="dialog-msg"></p>' +
      '<div class="dialog__actions">' +
      '<button type="button" class="btn btn--ghost glass" data-dialog-cancel></button>' +
      '<button type="button" class="btn btn--primary glass" data-dialog-confirm></button>' +
      '</div></div>';
    document.body.appendChild(backdrop);
    titleEl = backdrop.querySelector("#dialog-title");
    msgEl = backdrop.querySelector("#dialog-msg");
    cancelBtn = backdrop.querySelector("[data-dialog-cancel]");
    confirmBtn = backdrop.querySelector("[data-dialog-confirm]");

    cancelBtn.addEventListener("click", function () { close(false); });
    confirmBtn.addEventListener("click", function () { close(true); });
    backdrop.addEventListener("click", function (e) { if (e.target === backdrop) close(false); });
    document.addEventListener("keydown", function (e) {
      if (!backdrop.classList.contains("is-on")) return;
      if (e.key === "Escape") close(false);
    });
  }

  function close(result) {
    backdrop.classList.remove("is-on");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    var r = resolver;
    resolver = null;
    if (r) r(result);
  }

  // opts: { title, message, confirmLabel, cancelLabel, danger }
  function confirmDialog(opts) {
    ensure();
    opts = opts || {};
    titleEl.textContent = opts.title || "Confirmar ação";
    msgEl.textContent = opts.message || "";
    confirmBtn.textContent = opts.confirmLabel || "Confirmar";
    confirmBtn.classList.toggle("btn--danger", !!opts.danger);
    cancelBtn.textContent = opts.cancelLabel || "Cancelar";
    lastFocus = document.activeElement;
    backdrop.classList.add("is-on");
    confirmBtn.focus();
    return new Promise(function (resolve) { resolver = resolve; });
  }

  global.Dialog = { confirm: confirmDialog };
})(window);
