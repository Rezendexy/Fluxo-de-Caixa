(function (global) {
  "use strict";

  var Fi = global.Finance;
  var Format = global.Format;
  var MES_ABREV = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

  var user = null, profile = null;
  var categories = [];        // [{id,name,monthly_estimate,sort_order}]
  var incomeByMonth = {};     // {monthKey: amount}  -- só lançamentos explícitos
  var expensesByMonth = {};   // {monthKey: {catId: amount}} -- só lançamentos explícitos
  var months = [];
  var manualExtra = [];
  var pendingFocus = null;    // {row, col}
  var computed = null;

  function normalizeMonth(d) { return String(d).slice(0, 7) + "-01"; }

  function setHint(msg, isError) {
    var el = document.getElementById("sheet-savehint");
    el.textContent = msg || " ";
    el.classList.toggle("is-error", !!isError);
  }

  function recomputeMonths() {
    var latest = Fi.todayKey();
    Object.keys(incomeByMonth).forEach(function (m) { if (m > latest) latest = m; });
    Object.keys(expensesByMonth).forEach(function (m) { if (m > latest) latest = m; });
    manualExtra.forEach(function (m) { if (m > latest) latest = m; });
    var start = normalizeMonth(profile.start_month || Fi.todayKey());
    if (start > latest) latest = start;
    months = Fi.monthRange(start, latest);
  }

  function editableRowKeys() {
    return ["income"].concat(categories.map(function (c) { return "cat:" + c.id; }));
  }

  /* ============ carregamento ============ */
  function loadAll() {
    var db = global.DB.client;
    return Promise.all([
      db.from("categories").select("*").eq("user_id", user.id).order("sort_order", { ascending: true }),
      db.from("income_entries").select("month,amount").eq("user_id", user.id),
      db.from("expense_entries").select("category_id,month,amount").eq("user_id", user.id)
    ]).then(function (res) {
      var catsRes = res[0], incRes = res[1], expRes = res[2];
      categories = (catsRes.data || []).map(function (c) {
        return { id: c.id, name: c.name, monthly_estimate: Number(c.monthly_estimate) || 0, sort_order: c.sort_order };
      });
      incomeByMonth = {};
      (incRes.data || []).forEach(function (r) { incomeByMonth[normalizeMonth(r.month)] = Number(r.amount) || 0; });
      expensesByMonth = {};
      (expRes.data || []).forEach(function (r) {
        var m = normalizeMonth(r.month);
        if (!expensesByMonth[m]) expensesByMonth[m] = {};
        expensesByMonth[m][r.category_id] = Number(r.amount) || 0;
      });
      recomputeMonths();
    });
  }

  /* ============ gravação (otimista) ============ */
  function upsertIncome(monthKey, amount) {
    setHint("Salvando…");
    global.DB.client.from("income_entries")
      .upsert({ user_id: user.id, month: monthKey, amount: amount }, { onConflict: "user_id,month" })
      .then(function (res) {
        setHint(res.error ? "Não foi possível salvar — verifique sua internet." : "Tudo salvo.", !!res.error);
      });
  }
  function upsertExpense(categoryId, monthKey, amount) {
    setHint("Salvando…");
    global.DB.client.from("expense_entries")
      .upsert({ user_id: user.id, category_id: categoryId, month: monthKey, amount: amount }, { onConflict: "user_id,category_id,month" })
      .then(function (res) {
        setHint(res.error ? "Não foi possível salvar — verifique sua internet." : "Tudo salvo.", !!res.error);
      });
  }

  function commitCell(input) {
    var rowKey = input.getAttribute("data-row");
    var col = parseInt(input.getAttribute("data-col"), 10);
    var monthKey = months[col];
    var raw = input.value.trim();
    var val = raw === "" ? 0 : Format.parseNumber(raw);
    if (!isFinite(val) || val < 0) val = 0;

    if (rowKey === "income") {
      incomeByMonth[monthKey] = val;
      upsertIncome(monthKey, val);
    } else {
      var catId = rowKey.slice(4);
      if (!expensesByMonth[monthKey]) expensesByMonth[monthKey] = {};
      expensesByMonth[monthKey][catId] = val;
      upsertExpense(catId, monthKey, val);
    }
  }

  /* ============ categorias ============ */
  function addCategory(name) {
    var sortOrder = categories.length ? Math.max.apply(null, categories.map(function (c) { return c.sort_order; })) + 1 : 0;
    setHint("Salvando…");
    return global.DB.client.from("categories")
      .insert({ user_id: user.id, name: name, monthly_estimate: 0, sort_order: sortOrder })
      .select().single()
      .then(function (res) {
        if (res.error) { setHint("Não foi possível adicionar o gasto.", true); return; }
        categories.push({ id: res.data.id, name: res.data.name, monthly_estimate: 0, sort_order: res.data.sort_order });
        setHint("Tudo salvo.");
        render();
      });
  }
  function renameCategory(catId, name) {
    var cat = categories.filter(function (c) { return c.id === catId; })[0];
    if (!cat || cat.name === name) return;
    cat.name = name;
    setHint("Salvando…");
    global.DB.client.from("categories").update({ name: name }).eq("id", catId).then(function (res) {
      setHint(res.error ? "Não foi possível renomear." : "Tudo salvo.", !!res.error);
    });
  }
  function deleteCategory(catId) {
    if (!global.confirm("Remover este gasto e todo o histórico dele? Essa ação não pode ser desfeita.")) return;
    setHint("Removendo…");
    global.DB.client.from("categories").delete().eq("id", catId).then(function (res) {
      if (res.error) { setHint("Não foi possível remover.", true); return; }
      categories = categories.filter(function (c) { return c.id !== catId; });
      Object.keys(expensesByMonth).forEach(function (m) { delete expensesByMonth[m][catId]; });
      setHint("Tudo salvo.");
      render();
    });
  }

  /* ============ hero stats + gráfico ============ */
  function renderHero() {
    var today = Fi.todayKey();
    var realMonths = months.filter(function (m) { return m <= today; });
    var lastReal = realMonths.length ? realMonths[realMonths.length - 1] : null;

    var total = lastReal ? computed.cumulative[lastReal] : 0;
    var thisMonth = realMonths.indexOf(today) > -1 ? computed.balance[today] : 0;

    document.getElementById("hs-total-value").textContent = Format.money(total);
    document.getElementById("hs-total").classList.toggle("herostat--negative", total < 0);
    document.getElementById("hs-total-caption").textContent = total >= 0
      ? "desde que você começou a controlar seus gastos"
      : "você ainda está gastando mais do que recebe — dá para virar o jogo";

    document.getElementById("hs-month-value").textContent = Format.money(thisMonth);
    document.getElementById("hs-month").classList.toggle("herostat--negative", thisMonth < 0);
    document.getElementById("hs-month-caption").textContent = Format.capitalize(Fi.monthLabel(today));

    var streak = 0;
    for (var i = realMonths.length - 1; i >= 0; i--) {
      if (computed.balance[realMonths[i]] >= 0) streak++; else break;
    }
    document.getElementById("hs-streak-value").textContent = String(streak);
    document.getElementById("hs-streak-total").textContent = String(realMonths.length);

    var labels = realMonths.map(function (m) {
      var withYear = Fi.yearOf(realMonths[0]) !== Fi.yearOf(m);
      return MES_ABREV[parseInt(m.split("-")[1], 10) - 1] + (withYear ? "/" + String(Fi.yearOf(m)).slice(2) : "");
    });
    var values = realMonths.map(function (m) { return computed.cumulative[m]; });
    global.SheetChart.draw(document.getElementById("sheet-chart"), {
      labels: labels,
      values: values,
      tooltip: function (k) {
        var m = realMonths[k];
        return '<div class="tip__time">' + Format.capitalize(Fi.monthLabel(m)) + " de " + Fi.yearOf(m) + '</div>' +
          '<div class="tip__main">' + Format.money(values[k]) + '</div>' +
          '<div class="tip__label">saldo acumulado</div>';
      }
    });
  }

  /* ============ render da tabela ============ */
  function cellHTML(rowKey, col, cellState) {
    var val = cellState.amount;
    var muted = cellState.isDefault ? " cell--default" : "";
    var placeholder = cellState.isDefault && val ? Format.fmtNum.format(val) : "0,00";
    return '<td class="sheet__cell">' +
      '<div class="cellbox' + muted + '"><span class="cellbox__affix">R$</span>' +
      '<input type="text" inputmode="decimal" class="cellbox__input" placeholder="' + placeholder + '" ' +
      'value="' + (cellState.isDefault ? "" : Format.fmtNum.format(val)) + '" ' +
      'data-row="' + rowKey + '" data-col="' + col + '"></div></td>';
  }

  function render() {
    computed = Fi.computeSheet(months, categories, profile.monthly_income, incomeByMonth, expensesByMonth);

    // ---- cabeçalho ----
    var thead = '<tr><th class="sheet__corner">&nbsp;</th>';
    months.forEach(function (m) {
      thead += '<th class="sheet__monthhead"><span class="sheet__monthname">' + Format.capitalize(Fi.monthLabel(m)) + '</span>' +
        '<span class="sheet__monthyear">' + Fi.yearOf(m) + '</span></th>';
    });
    thead += "</tr>";
    document.getElementById("sheet-thead").innerHTML = thead;

    // ---- corpo ----
    var body = "";

    body += '<tr class="row--income"><td class="sheet__rowhead">Receita</td>';
    months.forEach(function (m, col) { body += cellHTML("income", col, computed.income[m]); });
    body += "</tr>";

    categories.forEach(function (cat) {
      body += '<tr class="row--expense" data-cat-row="' + cat.id + '">' +
        '<td class="sheet__rowhead sheet__rowhead--editable">' +
        '<input type="text" class="rowname" value="' + Format.esc(cat.name) + '" data-cat-name="' + cat.id + '">' +
        '<button type="button" class="rowremove" data-cat-remove="' + cat.id + '" aria-label="Remover ' + Format.esc(cat.name) + '">&times;</button>' +
        '</td>';
      months.forEach(function (m, col) { body += cellHTML("cat:" + cat.id, col, computed.expenses[cat.id][m]); });
      body += "</tr>";
    });

    body += '<tr class="row--addcat"><td class="sheet__rowhead sheet__rowhead--editable">' +
      '<input type="text" class="rowname rowname--ghost" id="sheet-newcat" placeholder="+ Adicionar gasto"></td>' +
      '<td class="cell--ghost" colspan="' + months.length + '"></td></tr>';

    body += '<tr class="row--total"><td class="sheet__rowhead">Total gastos</td>';
    months.forEach(function (m) { body += '<td class="sheet__computed"><span>' + Format.money(computed.totalExpenses[m]) + '</span></td>'; });
    body += "</tr>";

    body += '<tr class="row--balance"><td class="sheet__rowhead">Saldo</td>';
    months.forEach(function (m) {
      var v = computed.balance[m];
      body += '<td class="sheet__computed"><span class="' + (v < 0 ? "is-negative" : "is-positive") + '">' + Format.money(v) + '</span></td>';
    });
    body += "</tr>";

    body += '<tr class="row--cumulative"><td class="sheet__rowhead">Saldo acumulado</td>';
    months.forEach(function (m) {
      var v = computed.cumulative[m];
      body += '<td class="sheet__computed"><span class="' + (v < 0 ? "is-negative" : "is-positive") + '">' + Format.money(v) + '</span></td>';
    });
    body += "</tr>";

    document.getElementById("sheet-tbody").innerHTML = body;

    wireCells();
    wireRowHeads();
    renderHero();

    if (pendingFocus) {
      var sel = '[data-row="' + pendingFocus.row + '"][data-col="' + pendingFocus.col + '"]';
      var el = document.querySelector(sel);
      pendingFocus = null;
      if (el) { el.focus(); el.select(); }
    }
  }

  function wireCells() {
    document.querySelectorAll(".cellbox__input").forEach(function (input) {
      input.addEventListener("focus", function () { input.select(); });
      input.addEventListener("input", function () { input.setAttribute("data-dirty", "1"); });
      input.addEventListener("blur", function () {
        if (input.getAttribute("data-dirty") !== "1") return;
        input.removeAttribute("data-dirty");
        commitCell(input);
        render();
      });
      input.addEventListener("keydown", function (e) {
        if (e.key !== "Enter") return;
        e.preventDefault();
        var rows = editableRowKeys();
        var rowKey = input.getAttribute("data-row");
        var col = parseInt(input.getAttribute("data-col"), 10);
        var idx = Math.min(rows.length - 1, rows.indexOf(rowKey) + 1);
        pendingFocus = { row: rows[idx], col: col };
        input.blur();
      });
    });
  }

  function wireRowHeads() {
    document.querySelectorAll("[data-cat-name]").forEach(function (input) {
      input.addEventListener("blur", function () {
        var name = input.value.trim();
        var catId = input.getAttribute("data-cat-name");
        var cat = categories.filter(function (c) { return c.id === catId; })[0];
        if (!name) { input.value = cat.name; return; }
        renameCategory(catId, name);
      });
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
    });
    document.querySelectorAll("[data-cat-remove]").forEach(function (btn) {
      btn.addEventListener("click", function () { deleteCategory(btn.getAttribute("data-cat-remove")); });
    });
    var newcat = document.getElementById("sheet-newcat");
    if (newcat) {
      newcat.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); newcat.blur(); } });
      newcat.addEventListener("blur", function () {
        var name = newcat.value.trim();
        if (!name) return;
        addCategory(name);
      });
    }
  }

  function mount() {
    document.getElementById("btn-add-month").addEventListener("click", function () {
      var next = Fi.addMonths(months[months.length - 1], 1);
      manualExtra.push(next);
      months.push(next);
      render();
    });
  }

  function show(u, p) {
    user = u; profile = p;
    manualExtra = [];
    setHint("");
    loadAll().then(render);
  }

  global.SheetView = { mount: mount, show: show };
})(window);
