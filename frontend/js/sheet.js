(function (global) {
  "use strict";

  var Fi = global.Finance;
  var Format = global.Format;
  var MES_ABREV = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

  var user = null, profile = null;
  var categories = [];        // [{id,name,monthly_estimate,sort_order}]
  var incomeByMonth = {};     // {monthKey: amount}  -- só lançamentos explícitos
  var expensesByMonth = {};   // {monthKey: {catId: amount}} -- só lançamentos explícitos
  var realizedByMonth = {};   // {monthKey: {catId: amount}} -- gasto real, digitado à mão na aba "Realizada"
  var realizedIncomeByMonth = {}; // {monthKey: amount} -- receita real, digitada à mão na aba "Realizada"
  var selectedRealizedMonth = null;
  var months = [];
  var manualExtra = [];
  var pendingFocus = null;    // {m, k}
  var computed = null;
  var scrollHintDismissed = false;
  var colWidths = null;       // {value:{key:ch}, label:px} -- recalculado a cada render

  function normalizeMonth(d) { return String(d).slice(0, 7) + "-01"; }

  /* ============ autoajuste de coluna (tipo Excel) ============ */
  // cada coluna de valor nasce pequena e só cresce até caber o maior número
  // daquela LINHA (aquele gasto, em todos os meses) — nunca corta nem obriga
  // a rolar dentro do campo. a coluna fixa de nomes (esquerda) só cresce até
  // caber o maior nome de gasto.
  var MIN_VALUE_CH = 6;    // "999,99"
  var MIN_NAME_PX = 62;
  var measureCtx = null;
  function textWidthPx(text, font) {
    if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
    measureCtx.font = font;
    return measureCtx.measureText(String(text)).width;
  }
  function computeColWidths() {
    var value = { income: MIN_VALUE_CH };
    categories.forEach(function (c) { value["cat:" + c.id] = MIN_VALUE_CH; });

    months.forEach(function (m) {
      value.income = Math.max(value.income, Format.fmtNum.format(computed.income[m].amount).length);
      categories.forEach(function (c) {
        var k = "cat:" + c.id;
        value[k] = Math.max(value[k], Format.fmtNum.format(computed.expenses[c.id][m].amount).length);
      });
    });

    // +16: o input tem padding:8px 4px (8px de cada lado) e box-sizing
    // border-box, então esse tanto precisa entrar na largura total, senão
    // o texto vem cortado mesmo "cabendo" na medição bruta do canvas.
    var nameFont = "600 16px 'Bricolage Grotesque','Inter',system-ui,sans-serif";
    var labelPx = MIN_NAME_PX;
    categories.forEach(function (c) {
      labelPx = Math.max(labelPx, Math.ceil(textWidthPx(c.name, nameFont)) + 16);
    });

    return { value: value, label: labelPx };
  }

  function setHint(msg, isError, elId) {
    var el = document.getElementById(elId || "sheet-savehint");
    if (!el) return;
    el.textContent = msg || " ";
    el.classList.toggle("is-error", !!isError);
  }

  function recomputeMonths() {
    var latest = Fi.todayKey();
    Object.keys(incomeByMonth).forEach(function (m) { if (m > latest) latest = m; });
    Object.keys(expensesByMonth).forEach(function (m) { if (m > latest) latest = m; });
    manualExtra.forEach(function (m) { if (m > latest) latest = m; });
    var start = normalizeMonth(profile.start_month || Fi.todayKey());
    if (start > latest) latest = start;
    // o período escolhido no onboarding garante que a planilha já nasça com
    // todos os meses futuros planejados, mesmo sem nenhum lançamento neles.
    if (profile.plan_end_month) {
      var planEnd = normalizeMonth(profile.plan_end_month);
      if (planEnd > latest) latest = planEnd;
    }
    months = Fi.monthRange(start, latest);
  }

  /* ============ carregamento ============ */
  function loadAll() {
    var db = global.DB.client;
    return Promise.all([
      db.from("categories").select("*").eq("user_id", user.id).order("sort_order", { ascending: true }),
      db.from("income_entries").select("month,amount").eq("user_id", user.id),
      db.from("expense_entries").select("category_id,month,amount").eq("user_id", user.id),
      db.from("realized_expense_entries").select("category_id,month,amount").eq("user_id", user.id),
      db.from("realized_income_entries").select("month,amount").eq("user_id", user.id)
    ]).then(function (res) {
      var catsRes = res[0], incRes = res[1], expRes = res[2], realRes = res[3], realIncRes = res[4];
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
      realizedByMonth = {};
      (realRes.data || []).forEach(function (r) {
        var m = normalizeMonth(r.month);
        if (!realizedByMonth[m]) realizedByMonth[m] = {};
        realizedByMonth[m][r.category_id] = Number(r.amount) || 0;
      });
      realizedIncomeByMonth = {};
      (realIncRes.data || []).forEach(function (r) { realizedIncomeByMonth[normalizeMonth(r.month)] = Number(r.amount) || 0; });
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
  function upsertRealizedExpense(categoryId, monthKey, amount) {
    setHint("Salvando…", false, "realized-savehint");
    global.DB.client.from("realized_expense_entries")
      .upsert({ user_id: user.id, category_id: categoryId, month: monthKey, amount: amount }, { onConflict: "user_id,category_id,month" })
      .then(function (res) {
        if (res.error) console.error("realized_expense_entries upsert:", res.error);
        setHint(res.error ? "Não foi possível salvar — verifique sua internet." : "Tudo salvo.", !!res.error, "realized-savehint");
      });
  }
  function upsertRealizedIncome(monthKey, amount) {
    setHint("Salvando…", false, "realized-savehint");
    global.DB.client.from("realized_income_entries")
      .upsert({ user_id: user.id, month: monthKey, amount: amount }, { onConflict: "user_id,month" })
      .then(function (res) {
        if (res.error) console.error("realized_income_entries upsert:", res.error);
        setHint(res.error ? "Não foi possível salvar — verifique sua internet." : "Tudo salvo.", !!res.error, "realized-savehint");
      });
  }

  function commitCell(input) {
    var monthKey = months[parseInt(input.getAttribute("data-m"), 10)];
    var key = input.getAttribute("data-k");
    var raw = input.value.trim();
    var val = raw === "" ? 0 : Format.parseNumber(raw);
    if (!isFinite(val) || val < 0) val = 0;

    if (key === "income") {
      incomeByMonth[monthKey] = val;
      upsertIncome(monthKey, val);
    } else {
      var catId = key.slice(4);
      if (!expensesByMonth[monthKey]) expensesByMonth[monthKey] = {};
      expensesByMonth[monthKey][catId] = val;
      upsertExpense(catId, monthKey, val);
    }
  }

  /* ============ categorias ============ */
  // monthlyEstimate vira o padrão do gasto em todos os meses (igual à etapa
  // 2 do onboarding) — sem isso, um gasto criado direto na planilha só
  // teria valor no mês em que foi digitado, e os outros meses cairiam pra
  // zero em vez de repetir o mesmo valor.
  function addCategory(name, monthlyEstimate) {
    var sortOrder = categories.length ? Math.max.apply(null, categories.map(function (c) { return c.sort_order; })) + 1 : 0;
    setHint("Salvando…");
    return global.DB.client.from("categories")
      .insert({ user_id: user.id, name: name, monthly_estimate: monthlyEstimate || 0, sort_order: sortOrder })
      .select().single()
      .then(function (res) {
        if (res.error) { setHint("Não foi possível adicionar o gasto.", true); return; }
        categories.push({ id: res.data.id, name: res.data.name, monthly_estimate: Number(res.data.monthly_estimate) || 0, sort_order: res.data.sort_order });
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
      render(); // reajusta a largura da coluna de nomes pro novo texto
    });
  }
  function deleteCategory(catId) {
    var cat = categories.filter(function (c) { return c.id === catId; })[0];
    global.Dialog.confirm({
      title: "Remover gasto",
      message: 'Remover "' + (cat ? cat.name : "este gasto") + '" e todo o histórico dele? Essa ação não pode ser desfeita.',
      confirmLabel: "Remover",
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      setHint("Removendo…");
      global.DB.client.from("categories").delete().eq("id", catId).then(function (res) {
        if (res.error) { setHint("Não foi possível remover.", true); return; }
        categories = categories.filter(function (c) { return c.id !== catId; });
        Object.keys(expensesByMonth).forEach(function (m) { delete expensesByMonth[m][catId]; });
        Object.keys(realizedByMonth).forEach(function (m) { delete realizedByMonth[m][catId]; });
        setHint("Tudo salvo.");
        render();
      });
    });
  }

  /* ============ remover mês (só nas pontas) ============ */
  // a planilha é sempre um intervalo contínuo entre o mês inicial e o mais
  // recente, então só dá pra encolher pelas pontas: tirando o primeiro mês
  // (empurra o início pra frente) ou desfazendo um mês futuro adicionado
  // manualmente (o mês atual de verdade e o fim do período planejado nunca
  // saem sozinhos, eles voltam na próxima renderização).
  function deleteMonthEntries(monthKey) {
    return Promise.all([
      global.DB.client.from("income_entries").delete().eq("month", monthKey),
      global.DB.client.from("expense_entries").delete().eq("month", monthKey)
    ]).then(function (results) {
      return results.some(function (r) { return r.error; });
    });
  }
  function removeFirstMonth() {
    if (months.length <= 1) return;
    var monthKey = months[0];
    global.Dialog.confirm({
      title: "Remover mês",
      message: "Remover " + Fi.monthLabel(monthKey) + " de " + Fi.yearOf(monthKey) + " da planilha? Os lançamentos desse mês serão apagados.",
      confirmLabel: "Remover",
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      setHint("Removendo…");
      var nextStart = months[1];
      deleteMonthEntries(monthKey).then(function (hadError) {
        if (hadError) { setHint("Não foi possível remover.", true); return; }
        global.DB.client.from("profiles").update({ start_month: nextStart }).eq("id", user.id).then(function (res) {
          if (res.error) { setHint("Não foi possível salvar.", true); return; }
          profile.start_month = nextStart;
          delete incomeByMonth[monthKey];
          delete expensesByMonth[monthKey];
          delete realizedByMonth[monthKey];
          delete realizedIncomeByMonth[monthKey];
          manualExtra = manualExtra.filter(function (m) { return m !== monthKey; });
          recomputeMonths();
          setHint("Tudo salvo.");
          render();
        });
      });
    });
  }
  function removeLastMonth() {
    if (months.length <= 1) return;
    var monthKey = months[months.length - 1];
    if (manualExtra.indexOf(monthKey) === -1) return; // mês atual / fim do período planejado não podem ser removidos assim
    global.Dialog.confirm({
      title: "Remover mês",
      message: "Remover " + Fi.monthLabel(monthKey) + " de " + Fi.yearOf(monthKey) + " da planilha?",
      confirmLabel: "Remover",
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      setHint("Removendo…");
      deleteMonthEntries(monthKey).then(function (hadError) {
        if (hadError) { setHint("Não foi possível remover.", true); return; }
        delete incomeByMonth[monthKey];
        delete expensesByMonth[monthKey];
        delete realizedByMonth[monthKey];
        delete realizedIncomeByMonth[monthKey];
        manualExtra = manualExtra.filter(function (m) { return m !== monthKey; });
        recomputeMonths();
        setHint("Tudo salvo.");
        render();
      });
    });
  }

  /* ============ hero stats + gráfico ============ */
  // "Total economizado" e o gráfico olham pro PERÍODO INTEIRO da planilha
  // (início até o fim escolhido na etapa 3), não só pros meses que já
  // passaram — assim o aluno já vê pra onde o plano leva, com os valores
  // padrão preenchendo os meses futuros, em vez de esperar mês a mês.
  // "Economia deste mês" continua sobre o que já realmente aconteceu.
  function renderHero() {
    var today = Fi.todayKey();
    var realMonths = months.filter(function (m) { return m <= today; });
    var lastMonth = months[months.length - 1];

    var total = computed.cumulative[lastMonth];
    var thisMonth = realMonths.indexOf(today) > -1 ? computed.balance[today] : 0;

    document.getElementById("hs-total-value").textContent = Format.money(total);
    document.getElementById("hs-total").classList.toggle("herostat--negative", total < 0);
    document.getElementById("hs-total-caption").textContent =
      "previsto até " + Fi.monthLabel(lastMonth) + " de " + Fi.yearOf(lastMonth) +
      (total >= 0 ? ", considerando o que já foi planejado" : " — os gastos planejados estão maiores que a receita");

    document.getElementById("hs-month-value").textContent = Format.money(thisMonth);
    document.getElementById("hs-month").classList.toggle("herostat--negative", thisMonth < 0);
    document.getElementById("hs-month-caption").textContent = Format.capitalize(Fi.monthLabel(today));

    var labels = months.map(function (m) {
      var withYear = Fi.yearOf(months[0]) !== Fi.yearOf(m);
      return MES_ABREV[parseInt(m.split("-")[1], 10) - 1] + (withYear ? "/" + String(Fi.yearOf(m)).slice(2) : "");
    });
    var values = months.map(function (m) { return computed.cumulative[m]; });
    var single = null;
    if (months.length === 1) {
      var m0 = months[0];
      single = {
        income: computed.income[m0].amount,
        expenses: computed.totalExpenses[m0],
        balance: computed.balance[m0],
        label: Format.capitalize(Fi.monthLabel(m0)) + " de " + Fi.yearOf(m0)
      };
    }
    global.SheetChart.draw(document.getElementById("sheet-chart"), {
      labels: labels,
      values: values,
      single: single,
      tooltip: function (k) {
        var m = months[k];
        return '<div class="tip__time">' + Format.capitalize(Fi.monthLabel(m)) + " de " + Fi.yearOf(m) + '</div>' +
          '<div class="tip__main">' + Format.money(values[k]) + '</div>' +
          '<div class="tip__label">saldo acumulado</div>';
      }
    });
  }

  /* ============ dica de rolagem horizontal ============ */
  function updateScrollHint() {
    var el = document.getElementById("sheet-scroll");
    var hint = document.getElementById("sheet-scrollhint");
    if (el && hint) hint.classList.toggle("is-on", el.scrollWidth > el.clientWidth + 2 && !scrollHintDismissed);
  }

  /* ============ render da tabela ============ */
  // um GASTO por LINHA e um MÊS por COLUNA: dá pra comparar o mesmo gasto
  // ao longo dos meses lendo a linha inteira, ou ver a "foto" de um mês
  // inteiro lendo a coluna — igual a uma planilha de verdade.
  function cellHTML(m, key, cellState, extraCls) {
    var val = cellState.amount;
    var muted = cellState.isDefault ? " cell--default" : "";
    var placeholder = cellState.isDefault && val ? Format.fmtNum.format(val) : "0,00";
    var widthCh = colWidths.value[key] || MIN_VALUE_CH;
    return '<td class="sheet__cell' + (extraCls || "") + '">' +
      '<div class="cellbox' + muted + '"><span class="cellbox__affix">R$</span>' +
      '<input type="text" inputmode="decimal" class="cellbox__input" style="width:' + widthCh + 'ch" placeholder="' + placeholder + '" ' +
      'value="' + (cellState.isDefault ? "" : Format.fmtNum.format(val)) + '" ' +
      'data-m="' + m + '" data-k="' + key + '"></div></td>';
  }

  function monthHeadHTML(m, col, todayKey) {
    var isFirst = col === 0;
    var isLast = col === months.length - 1;
    var isToday = m === todayKey;
    var removable = months.length > 1 && (isFirst || (isLast && manualExtra.indexOf(m) > -1));
    var removeBtn = removable
      ? '<button type="button" class="monthcell__remove" data-month-remove="' + col + '" aria-label="Remover ' + Format.esc(Fi.monthLabel(m)) + '" title="Remover ' + Format.esc(Fi.monthLabel(m)) + '">&times;</button>'
      : "";
    return '<th class="sheet__monthhead' + (isToday ? " is-today" : "") + '"><div class="monthcell">' +
      '<div class="monthcell__text"><span class="monthcell__name">' + Format.capitalize(Fi.monthLabel(m)) + '</span>' +
      '<span class="monthcell__year">' + Fi.yearOf(m) + '</span>' +
      (isToday ? '<span class="monthcell__badge">atual</span>' : '') + '</div>' +
      removeBtn + '</div></th>';
  }

  function render() {
    computed = Fi.computeSheet(months, categories, profile.monthly_income, incomeByMonth, expensesByMonth);
    colWidths = computeColWidths();
    var todayKey = Fi.todayKey();

    // ---- cabeçalho: gasto (canto) | mês 1 | mês 2 | ... ----
    var thead = '<tr><th class="sheet__corner">Gasto</th>';
    months.forEach(function (m, col) { thead += monthHeadHTML(m, col, todayKey); });
    thead += "</tr>";
    document.getElementById("sheet-thead").innerHTML = thead;

    // ---- corpo: receita, cada gasto, "+ novo gasto", total, saldo — uma linha por item ----
    var body = "";

    body += '<tr class="sheet__row--income"><td class="sheet__rowhead sheet__rowhead--label sheet__rowhead--income">Receita</td>';
    months.forEach(function (m, col) {
      body += cellHTML(col, "income", computed.income[m], " sheet__cell--income" + (m === todayKey ? " is-today" : ""));
    });
    body += "</tr>";

    categories.forEach(function (cat) {
      body += '<tr><td class="sheet__rowhead"><div class="rowhead">' +
        '<input type="text" class="rowhead__name" style="width:' + colWidths.label + 'px" value="' + Format.esc(cat.name) + '" title="' + Format.esc(cat.name) + '" data-cat-name="' + cat.id + '">' +
        '<button type="button" class="rowhead__remove" data-cat-remove="' + cat.id + '" aria-label="Remover ' + Format.esc(cat.name) + '">&times;</button>' +
        '</div></td>';
      months.forEach(function (m, col) {
        body += cellHTML(col, "cat:" + cat.id, computed.expenses[cat.id][m], m === todayKey ? " is-today" : "");
      });
      body += "</tr>";
    });

    // linha fantasma "+ novo gasto": nome primeiro, valor mensal padrão
    // depois (igual à etapa 2 do onboarding) — só cria quando os dois
    // estiverem prontos, pra já nascer com o padrão certo em todos os meses.
    body += '<tr><td class="sheet__rowhead sheet__rowhead--add" id="sheet-addcat-head">' +
      '<div class="rowhead rowhead--ghost"><span class="rowhead__plus" aria-hidden="true">+</span>' +
      '<input type="text" class="rowhead__name rowhead__name--ghost" id="sheet-newcat" placeholder="Nome do gasto"></div>' +
      '<div class="newvalue" id="sheet-newcat-value-wrap" hidden>' +
      '<span class="newvalue__affix">R$</span>' +
      '<input type="text" inputmode="decimal" class="newvalue__input" id="sheet-newcat-value" placeholder="0,00 por mês"></div></td>';
    months.forEach(function () { body += '<td class="cell--ghost"></td>'; });
    body += "</tr>";

    body += '<tr class="sheet__row--totalstart"><td class="sheet__rowhead sheet__rowhead--label sheet__rowhead--computed">Total gastos</td>';
    months.forEach(function (m) {
      body += '<td class="sheet__computed' + (m === todayKey ? " is-today" : "") + '"><span>' + Format.money(computed.totalExpenses[m]) + '</span></td>';
    });
    body += "</tr>";

    body += '<tr><td class="sheet__rowhead sheet__rowhead--label sheet__rowhead--computed">Saldo</td>';
    months.forEach(function (m) {
      var bal = computed.balance[m];
      body += '<td class="sheet__computed' + (m === todayKey ? " is-today" : "") + '"><span class="' + (bal < 0 ? "is-negative" : "is-positive") + '">' + Format.money(bal) + '</span></td>';
    });
    body += "</tr>";

    document.getElementById("sheet-tbody").innerHTML = body;

    wireMonthRows();
    wireCells();
    wireColHeads();
    renderCumulative();
    renderHero();
    renderRealizedPanel();
    updateScrollHint();

    if (pendingFocus) {
      var sel = '[data-m="' + pendingFocus.m + '"][data-k="' + pendingFocus.k + '"]';
      var el = document.querySelector(sel);
      pendingFocus = null;
      if (el) { el.focus(); el.select(); }
    }
  }

  /* ============ tira do saldo acumulado (só leitura, mês em coluna) ============ */
  function renderCumulative() {
    var theadEl = document.getElementById("cum-thead");
    var tbodyEl = document.getElementById("cum-tbody");
    if (!theadEl || !tbodyEl) return;
    var todayKey = Fi.todayKey();

    var thead = "<tr>";
    var body = "<tr>";
    months.forEach(function (m) {
      var isToday = m === todayKey;
      thead += '<th class="cum__monthhead' + (isToday ? " is-today" : "") + '">' +
        '<span class="cum__monthname">' + Format.capitalize(Fi.monthLabel(m)) + '</span>' +
        '<span class="cum__monthyear">' + Fi.yearOf(m) + '</span></th>';
      var v = computed.cumulative[m];
      body += '<td class="cum__cell' + (isToday ? " is-today" : "") + '">' +
        '<span class="' + (v < 0 ? "is-negative" : "is-positive") + '">' + Format.money(v) + '</span></td>';
    });
    thead += "</tr>";
    body += "</tr>";
    theadEl.innerHTML = thead;
    tbodyEl.innerHTML = body;
  }

  /* ============ planilha realizada (mês selecionado: projetado x realizado) ============ */
  // um único mês por vez (escolhido no seletor), com duas mini-planilhas do
  // mesmo formato — cada gasto por linha, uma coluna de valor: a de cima só
  // leitura (o que foi projetado), a de baixo editável (o que realmente
  // aconteceu, sem editar ainda mostra o projetado como sugestão cinza,
  // igual à planilha de projeção). No fim, uma faixa de diferença, no
  // mesmo espírito do "Saldo acumulado" da projeção.
  function computeRealizedCell(catId, m) {
    var projected = computed.expenses[catId][m].amount;
    var monthReal = realizedByMonth[m] || {};
    var hasReal = Object.prototype.hasOwnProperty.call(monthReal, catId);
    return { amount: hasReal ? monthReal[catId] : 0, hasReal: hasReal, projected: projected };
  }

  function computeRealizedIncome(m) {
    var projected = computed.income[m].amount;
    var hasReal = Object.prototype.hasOwnProperty.call(realizedIncomeByMonth, m);
    return { amount: hasReal ? realizedIncomeByMonth[m] : 0, hasReal: hasReal, projected: projected };
  }

  function defaultRealizedMonth() {
    var today = Fi.todayKey();
    if (months.indexOf(today) > -1) return today;
    var past = months.filter(function (m) { return m <= today; });
    return past.length ? past[past.length - 1] : months[months.length - 1];
  }

  function computeMiniWidth(m) {
    var w = MIN_VALUE_CH;
    var incCell = computeRealizedIncome(m);
    w = Math.max(w, Format.fmtNum.format(incCell.projected).length, Format.fmtNum.format(incCell.amount).length);
    var totalReal = 0;
    categories.forEach(function (c) {
      var cell = computeRealizedCell(c.id, m);
      w = Math.max(w, Format.fmtNum.format(cell.projected).length, Format.fmtNum.format(cell.amount).length);
      totalReal += cell.amount;
    });
    w = Math.max(w, Format.fmtNum.format(computed.totalExpenses[m]).length);
    w = Math.max(w, Format.fmtNum.format(computed.balance[m]).length);
    w = Math.max(w, Format.fmtNum.format(totalReal).length);
    w = Math.max(w, Format.fmtNum.format(incCell.amount - totalReal).length);
    return w;
  }

  // mesmas classes da planilha de projeção (sheet__rowhead/sheet__computed/
  // sheet__cell) — assim a linha nasce com a fonte, o zebra e as bordas
  // certas de graça, sem duplicar CSS. extraCls é o extra específico da
  // linha (ex.: "sheet__rowhead--income" na Receita, que também tinge as
  // células de valor via "sheet__cell--income"). a célula "Realizado" só
  // leva "sheet__cell" (o wrapper certo pra um .cellbox editável) nas
  // linhas de gasto/receita — em "Total gastos"/"Saldo" ela é texto pronto,
  // igual às outras duas colunas, então precisa de "sheet__computed"
  // (mesma fonte mono tabular), senão cai na fonte padrão do body.
  function gridRowHTML(name, projHTML, realHTML, diffHTML, rowCls, extraCls) {
    var extra = extraCls ? " " + extraCls : "";
    var isComputedRow = extraCls === "sheet__rowhead--computed";
    var cellExtra = extraCls === "sheet__rowhead--income" ? " sheet__cell--income" : "";
    var realCls = isComputedRow ? "sheet__computed" : "sheet__cell";
    return '<tr class="' + (rowCls || "") + '">' +
      '<td class="sheet__rowhead sheet__rowhead--label' + extra + '">' + name + '</td>' +
      '<td class="sheet__computed' + cellExtra + '">' + projHTML + '</td>' +
      '<td class="' + realCls + cellExtra + '">' + realHTML + '</td>' +
      '<td class="sheet__computed' + cellExtra + '">' + diffHTML + '</td></tr>';
  }

  // isGood: true colore verde (accent-ink), false colore vermelho (danger) —
  // mesma cor "de verdade" do cellbox editado (is-good/is-bad), não o
  // is-positive/is-negative (--warm) usado pro saldo puro. o significado de
  // "bom" muda por linha (gastar menos é bom, receber mais é bom), então
  // quem chama decide a direção.
  function diffValueHTML(diff, known, isGood) {
    if (!known) return '<span class="realizedgrid__diff-empty">—</span>';
    return '<span class="' + (isGood ? "is-good" : "is-bad") + '">' + Format.money(diff) + '</span>';
  }

  function monthOptionLabel(m) { return Format.capitalize(Fi.monthLabel(m)) + " de " + Fi.yearOf(m); }

  function renderRealizedMonthOptions() {
    var menu = document.getElementById("realized-month-menu");
    var valueEl = document.getElementById("realized-month-value");
    if (!menu || !valueEl) return;
    var target = selectedRealizedMonth && months.indexOf(selectedRealizedMonth) > -1
      ? selectedRealizedMonth
      : defaultRealizedMonth();
    selectedRealizedMonth = target;

    menu.innerHTML = months.map(function (m) {
      var selected = m === target;
      return '<button type="button" class="monthpicker__option' + (selected ? " is-selected" : "") + '" role="option" ' +
        'aria-selected="' + (selected ? "true" : "false") + '" data-month="' + m + '">' + Format.esc(monthOptionLabel(m)) + '</button>';
    }).join("");
    valueEl.textContent = monthOptionLabel(target);
  }

  function renderRealizedPanel() {
    var tbody = document.getElementById("realized-tbody");
    if (!tbody || !computed) return;

    renderRealizedMonthOptions();
    var m = selectedRealizedMonth;
    if (!m) return;
    var widthCh = computeMiniWidth(m);
    var incCell = computeRealizedIncome(m);

    // ---- linha da receita ----
    var incDiff = incCell.amount - incCell.projected;
    var incPlaceholder = "0,00";
    var incBoxCls = "cellbox" + (incCell.hasReal ? "" : " cell--default");
    if (incCell.hasReal) incBoxCls += incDiff < 0 ? " is-bad" : " is-good";
    var incRealHTML = '<div class="' + incBoxCls + '"><span class="cellbox__affix">R$</span>' +
      '<input type="text" inputmode="decimal" class="cellbox__input realized-money-input" style="width:' + widthCh + 'ch" placeholder="' + incPlaceholder + '" ' +
      'value="' + (incCell.hasReal ? Format.fmtNum.format(incCell.amount) : "") + '" data-income="1"></div>';
    var rows = gridRowHTML("Receita", "<span>" + Format.money(incCell.projected) + "</span>", incRealHTML,
      diffValueHTML(incDiff, incCell.hasReal, incDiff >= 0), "sheet__row--income", "sheet__rowhead--income");

    // ---- uma linha por gasto (projetado, realizado editável, diferença) ----
    var totalReal = 0;
    if (!categories.length) {
      rows += '<tr><td class="realized-empty" colspan="4">Nenhum gasto cadastrado ainda — adicione um na planilha de projeção.</td></tr>';
    } else {
      categories.forEach(function (cat) {
        var cell = computeRealizedCell(cat.id, m);
        totalReal += cell.amount;
        var diff = cell.amount - cell.projected;
        var placeholder = "0,00";
        var boxCls = "cellbox" + (cell.hasReal ? "" : " cell--default");
        if (cell.hasReal) boxCls += diff > 0 ? " is-bad" : " is-good";
        var realHTML = '<div class="' + boxCls + '"><span class="cellbox__affix">R$</span>' +
          '<input type="text" inputmode="decimal" class="cellbox__input realized-money-input" style="width:' + widthCh + 'ch" placeholder="' + placeholder + '" ' +
          'value="' + (cell.hasReal ? Format.fmtNum.format(cell.amount) : "") + '" data-cat="' + cat.id + '"></div>';
        rows += gridRowHTML(Format.esc(cat.name), "<span>" + Format.money(cell.projected) + "</span>", realHTML,
          diffValueHTML(diff, cell.hasReal, diff <= 0));
      });
    }

    // ---- total gastos e saldo ----
    var totalProj = computed.totalExpenses[m];
    var balProj = computed.balance[m];
    var balReal = incCell.amount - totalReal;
    rows += gridRowHTML("Total gastos", "<span>" + Format.money(totalProj) + "</span>", "<span>" + Format.money(totalReal) + "</span>",
      diffValueHTML(totalReal - totalProj, true, totalReal <= totalProj), "sheet__row--totalstart", "sheet__rowhead--computed");
    rows += gridRowHTML("Saldo",
      '<span class="' + (balProj < 0 ? "is-negative" : "is-positive") + '">' + Format.money(balProj) + "</span>",
      '<span class="' + (balReal < 0 ? "is-negative" : "is-positive") + '">' + Format.money(balReal) + "</span>",
      diffValueHTML(balReal - balProj, true, balReal >= balProj), "", "sheet__rowhead--computed");

    tbody.innerHTML = rows;

    wireRealizedInputs();

    // ---- diferença (mesmo espírito do "Saldo acumulado") ----
    var diff = balReal - balProj;
    var diffCell = document.getElementById("realized-diff-cell");
    var projEl = document.getElementById("realized-diff-projected");
    var realEl = document.getElementById("realized-diff-actual");
    var diffEl = document.getElementById("realized-diff-value");
    if (projEl) projEl.textContent = Format.money(balProj);
    if (realEl) realEl.textContent = Format.money(balReal);
    if (diffEl) diffEl.textContent = Format.money(diff);
    if (diffCell) {
      diffCell.classList.remove("is-positive", "is-negative");
      diffCell.classList.add(diff < 0 ? "is-negative" : "is-positive");
    }

    renderRealizedHero();
  }

  function commitRealizedInput(input) {
    var m = selectedRealizedMonth;
    if (!m) return;
    var raw = input.value.trim();
    var val = raw === "" ? null : Format.parseNumber(raw);
    if (val != null && (!isFinite(val) || val < 0)) val = 0;

    if (input.hasAttribute("data-income")) {
      if (val == null) {
        if (Object.prototype.hasOwnProperty.call(realizedIncomeByMonth, m)) {
          delete realizedIncomeByMonth[m];
          setHint("Salvando…", false, "realized-savehint");
          global.DB.client.from("realized_income_entries").delete()
            .eq("user_id", user.id).eq("month", m)
            .then(function (res) {
              if (res.error) console.error("realized_income_entries delete:", res.error);
              setHint(res.error ? "Não foi possível salvar — verifique sua internet." : "Tudo salvo.", !!res.error, "realized-savehint");
            });
        }
      } else {
        realizedIncomeByMonth[m] = val;
        upsertRealizedIncome(m, val);
      }
      renderRealizedPanel();
      return;
    }

    var catId = input.getAttribute("data-cat");
    if (!catId) return;
    if (val == null) {
      if (realizedByMonth[m] && Object.prototype.hasOwnProperty.call(realizedByMonth[m], catId)) {
        delete realizedByMonth[m][catId];
        setHint("Salvando…", false, "realized-savehint");
        global.DB.client.from("realized_expense_entries").delete()
          .eq("user_id", user.id).eq("category_id", catId).eq("month", m)
          .then(function (res) {
            if (res.error) console.error("realized_expense_entries delete:", res.error);
            setHint(res.error ? "Não foi possível salvar — verifique sua internet." : "Tudo salvo.", !!res.error, "realized-savehint");
          });
      }
    } else {
      if (!realizedByMonth[m]) realizedByMonth[m] = {};
      realizedByMonth[m][catId] = val;
      upsertRealizedExpense(catId, m, val);
    }
    renderRealizedPanel();
  }

  function wireRealizedInputs() {
    document.querySelectorAll(".realized-money-input").forEach(function (input) {
      input.addEventListener("focus", function () { input.select(); });
      input.addEventListener("blur", function () { commitRealizedInput(input); });
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
    });
  }

  function wireRealizedMonthPicker() {
    var wrap = document.getElementById("realized-monthpicker");
    var trigger = document.getElementById("realized-month-trigger");
    var menu = document.getElementById("realized-month-menu");
    if (!wrap || !trigger || !menu || wrap.getAttribute("data-wired")) return;
    wrap.setAttribute("data-wired", "1");

    function close() {
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
    }
    function open() {
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      var current = menu.querySelector('.monthpicker__option[aria-selected="true"]');
      if (current) current.focus();
    }

    trigger.addEventListener("click", function () {
      if (menu.hidden) open(); else close();
    });
    trigger.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); open(); }
      else if (e.key === "Escape") close();
    });

    menu.addEventListener("click", function (e) {
      var opt = e.target.closest(".monthpicker__option");
      if (!opt) return;
      selectedRealizedMonth = opt.getAttribute("data-month");
      close();
      trigger.focus();
      renderRealizedPanel();
    });
    menu.addEventListener("keydown", function (e) {
      var opts = Array.prototype.slice.call(menu.querySelectorAll(".monthpicker__option"));
      var idx = opts.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); (opts[idx + 1] || opts[0]).focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); (opts[idx - 1] || opts[opts.length - 1]).focus(); }
      else if (e.key === "Escape") { e.preventDefault(); close(); trigger.focus(); }
      else if (e.key === "Tab") { close(); }
    });

    document.addEventListener("click", function (e) {
      if (!menu.hidden && !wrap.contains(e.target)) close();
    });
  }

  /* ============ hero stats da planilha realizada (só o que já aconteceu) ============ */
  function computeRealizedSummary() {
    var today = Fi.todayKey();
    var running = 0, monthBal = 0, found = false;
    months.forEach(function (m) {
      if (m > today) return;
      var totalReal = 0;
      categories.forEach(function (cat) { totalReal += computeRealizedCell(cat.id, m).amount; });
      var bal = computeRealizedIncome(m).amount - totalReal;
      running += bal;
      if (m === today) { monthBal = bal; found = true; }
    });
    return { total: running, month: found ? monthBal : 0 };
  }

  function renderRealizedHero() {
    if (!computed) return;
    var totalEl = document.getElementById("rhs-total-value");
    var totalCard = document.getElementById("rhs-total");
    var monthEl = document.getElementById("rhs-month-value");
    var monthCard = document.getElementById("rhs-month");
    var monthCaption = document.getElementById("rhs-month-caption");
    if (!totalEl || !monthEl) return;

    var summary = computeRealizedSummary();
    totalEl.textContent = Format.money(summary.total);
    if (totalCard) totalCard.classList.toggle("herostat--negative", summary.total < 0);
    monthEl.textContent = Format.money(summary.month);
    if (monthCard) monthCard.classList.toggle("herostat--negative", summary.month < 0);
    if (monthCaption) monthCaption.textContent = Format.capitalize(Fi.monthLabel(Fi.todayKey()));
  }

  function wireSheetTabs() {
    var tabProj = document.getElementById("tab-sheet-projecao");
    var tabReal = document.getElementById("tab-sheet-realizada");
    var panelProj = document.getElementById("sheet-panel-projecao");
    var panelReal = document.getElementById("sheet-panel-realizada");
    if (!tabProj || !tabReal || tabProj.getAttribute("data-wired")) return;
    tabProj.setAttribute("data-wired", "1");

    function activate(which) {
      var isProj = which === "projecao";
      tabProj.setAttribute("aria-selected", isProj ? "true" : "false");
      tabProj.tabIndex = isProj ? 0 : -1;
      tabReal.setAttribute("aria-selected", isProj ? "false" : "true");
      tabReal.tabIndex = isProj ? -1 : 0;
      panelProj.hidden = !isProj;
      panelReal.hidden = isProj;
      if (!isProj) renderRealizedPanel();
      updateScrollHint();
    }
    tabProj.addEventListener("click", function () { activate("projecao"); });
    tabReal.addEventListener("click", function () { activate("realizada"); });
  }

  function wireMonthRows() {
    document.querySelectorAll("[data-month-remove]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var col = parseInt(btn.getAttribute("data-month-remove"), 10);
        if (col === 0) removeFirstMonth(); else removeLastMonth();
      });
    });
  }

  function wireCells() {
    document.querySelectorAll("#sheet-tbody .cellbox__input").forEach(function (input) {
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
        var key = input.getAttribute("data-k");
        var m = parseInt(input.getAttribute("data-m"), 10);
        var nextM = Math.min(months.length - 1, m + 1);
        pendingFocus = { m: nextM, k: key };
        input.blur();
      });
    });
  }

  function wireColHeads() {
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
    // etapa 1: nome. Ao confirmar, revela a etapa 2 (valor mensal) em vez
    // de criar na hora — só cria quando o valor também for confirmado, pra
    // já nascer com o padrão certo em todos os meses.
    var newcat = document.getElementById("sheet-newcat");
    var newcatValueWrap = document.getElementById("sheet-newcat-value-wrap");
    var newcatValue = document.getElementById("sheet-newcat-value");
    if (newcat) {
      newcat.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); newcat.blur(); } });
      newcat.addEventListener("blur", function () {
        var name = newcat.value.trim();
        if (!name || !newcatValueWrap) return;
        newcatValueWrap.hidden = false;
        newcatValue.focus();
      });
    }
    // etapa 2: valor mensal padrão.
    if (newcatValue) {
      newcatValue.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); newcatValue.blur(); } });
      newcatValue.addEventListener("blur", function () {
        var name = newcat ? newcat.value.trim() : "";
        if (!name) { newcatValueWrap.hidden = true; return; }
        var amount = Format.parseNumber(newcatValue.value);
        addCategory(name, isFinite(amount) && amount > 0 ? amount : 0);
      });
    }
    var addHead = document.getElementById("sheet-addcat-head");
    if (addHead) {
      addHead.addEventListener("click", function (e) {
        if (e.target && (e.target.id === "sheet-newcat" || e.target.id === "sheet-newcat-value")) return;
        if (newcatValueWrap && !newcatValueWrap.hidden) { newcatValue.focus(); return; }
        if (newcat) newcat.focus();
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

    wireSheetTabs();
    wireRealizedMonthPicker();

    // redesenha o gráfico quando a tela muda de tamanho (ex.: girar o celular),
    // já que o SVG usa a largura real do contêiner para o texto ficar legível.
    var resizeTimer = null;
    global.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (computed) renderHero();
        updateScrollHint();
      }, 150);
    });

    var scrollEl = document.getElementById("sheet-scroll");
    if (scrollEl) {
      scrollEl.addEventListener("scroll", function () {
        scrollHintDismissed = true;
        updateScrollHint();
      }, { passive: true, once: true });
    }
  }

  function show(u, p) {
    user = u; profile = p;
    manualExtra = [];
    selectedRealizedMonth = null;
    setHint("");
    setHint("", false, "realized-savehint");
    loadAll().then(render);
  }

  global.SheetView = { mount: mount, show: show };
})(window);
