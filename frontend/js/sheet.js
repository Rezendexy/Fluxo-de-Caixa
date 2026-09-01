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
  var pendingFocus = null;    // {m, k}
  var computed = null;
  var scrollHintDismissed = false;
  var colWidths = null;       // {value:{key:ch}, name:{catId:px}} -- recalculado a cada render

  function normalizeMonth(d) { return String(d).slice(0, 7) + "-01"; }

  /* ============ autoajuste de coluna (tipo Excel) ============ */
  // cada coluna nasce pequena e só cresce até caber o maior conteúdo que
  // ela precisa mostrar (o valor mais largo lançado em qualquer mês, ou o
  // nome do gasto) — nunca corta nem obriga a rolar dentro do campo.
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
    var name = {};
    categories.forEach(function (c) {
      name[c.id] = Math.max(MIN_NAME_PX, Math.ceil(textWidthPx(c.name, nameFont)) + 16);
    });

    return { value: value, name: name };
  }

  function setHint(msg, isError) {
    var el = document.getElementById("sheet-savehint");
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
      render(); // reajusta a largura da coluna pro novo nome
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
  // "Economia deste mês" e "Meses no azul" continuam sobre o que já
  // realmente aconteceu (não dá pra ter "sequência no azul" de um mês que
  // ainda nem chegou).
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

    var streak = 0;
    for (var i = realMonths.length - 1; i >= 0; i--) {
      if (computed.balance[realMonths[i]] >= 0) streak++; else break;
    }
    document.getElementById("hs-streak-value").textContent = String(streak);
    document.getElementById("hs-streak-total").textContent = String(realMonths.length);

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
    if (!el || !hint) return;
    var overflowing = el.scrollWidth > el.clientWidth + 2;
    hint.classList.toggle("is-on", overflowing && !scrollHintDismissed);
  }

  /* ============ render da tabela ============ */
  // a planilha é montada com um mês por LINHA e um gasto por COLUNA: no
  // celular isso vira uma rolagem vertical natural (mês a mês) em vez de
  // rolagem lateral por muitos meses, que era a fonte da bagunça visual.
  function cellHTML(m, key, cellState) {
    var val = cellState.amount;
    var muted = cellState.isDefault ? " cell--default" : "";
    var placeholder = cellState.isDefault && val ? Format.fmtNum.format(val) : "0,00";
    var widthCh = colWidths.value[key] || MIN_VALUE_CH;
    return '<td class="sheet__cell' + (key === "income" ? " sheet__cell--income" : "") + '">' +
      '<div class="cellbox' + muted + '"><span class="cellbox__affix">R$</span>' +
      '<input type="text" inputmode="decimal" class="cellbox__input" style="width:' + widthCh + 'ch" placeholder="' + placeholder + '" ' +
      'value="' + (cellState.isDefault ? "" : Format.fmtNum.format(val)) + '" ' +
      'data-m="' + m + '" data-k="' + key + '"></div></td>';
  }

  function render() {
    computed = Fi.computeSheet(months, categories, profile.monthly_income, incomeByMonth, expensesByMonth);
    colWidths = computeColWidths();
    var todayKey = Fi.todayKey();

    // ---- cabeçalho: mês | receita | gasto 1 | gasto 2 | ... | + | total | saldo ----
    // saldo acumulado não mora mais aqui — vira uma tira própria, só leitura,
    // logo abaixo da planilha (renderCumulative).
    var thead = '<tr><th class="sheet__corner">Mês</th>' +
      '<th class="sheet__colhead sheet__colhead--income">Receita</th>';
    categories.forEach(function (cat) {
      thead += '<th class="sheet__colhead sheet__colhead--cat" data-cat-col="' + cat.id + '">' +
        '<div class="colhead">' +
        '<input type="text" class="colhead__name" style="width:' + colWidths.name[cat.id] + 'px" value="' + Format.esc(cat.name) + '" title="' + Format.esc(cat.name) + '" data-cat-name="' + cat.id + '">' +
        '<button type="button" class="colhead__remove" data-cat-remove="' + cat.id + '" aria-label="Remover ' + Format.esc(cat.name) + '">&times;</button>' +
        '</div></th>';
    });
    // dois passos no mesmo lugar: nome primeiro, depois o valor mensal
    // padrão aparece (igual à etapa 2 do onboarding) — só cria a categoria
    // quando os dois estiverem prontos, pra já nascer com o padrão certo.
    thead += '<th class="sheet__colhead sheet__colhead--add" id="sheet-addcat-head">' +
      '<div class="colhead colhead--ghost"><span class="colhead__plus" aria-hidden="true">+</span>' +
      '<input type="text" class="colhead__name colhead__name--ghost" id="sheet-newcat" placeholder="Nome do gasto"></div>' +
      '<div class="newvalue" id="sheet-newcat-value-wrap" hidden>' +
      '<span class="newvalue__affix">R$</span>' +
      '<input type="text" inputmode="decimal" class="newvalue__input" id="sheet-newcat-value" placeholder="0,00 por mês"></div></th>';
    thead += '<th class="sheet__colhead sheet__colhead--computed">Total gastos</th>';
    thead += '<th class="sheet__colhead sheet__colhead--computed">Saldo</th>';
    thead += "</tr>";
    document.getElementById("sheet-thead").innerHTML = thead;

    // ---- corpo: uma linha por mês ----
    var body = "";
    months.forEach(function (m, row) {
      var isFirst = row === 0;
      var isLast = row === months.length - 1;
      var isToday = m === todayKey;
      var removable = months.length > 1 && (isFirst || (isLast && manualExtra.indexOf(m) > -1));
      var removeBtn = removable
        ? '<button type="button" class="monthcell__remove" data-month-remove="' + row + '" aria-label="Remover ' + Format.esc(Fi.monthLabel(m)) + '" title="Remover ' + Format.esc(Fi.monthLabel(m)) + '">&times;</button>'
        : "";

      body += '<tr class="' + (isToday ? "is-today" : "") + '">';
      body += '<td class="sheet__monthcell"><div class="monthcell">' +
        '<div class="monthcell__text"><span class="monthcell__name">' + Format.capitalize(Fi.monthLabel(m)) + '</span>' +
        '<span class="monthcell__year">' + Fi.yearOf(m) + '</span>' +
        (isToday ? '<span class="monthcell__badge">atual</span>' : '') + '</div>' +
        removeBtn + '</div></td>';

      body += cellHTML(row, "income", computed.income[m]);
      categories.forEach(function (cat) { body += cellHTML(row, "cat:" + cat.id, computed.expenses[cat.id][m]); });
      body += '<td class="cell--ghost"></td>';
      body += '<td class="sheet__computed"><span>' + Format.money(computed.totalExpenses[m]) + '</span></td>';
      var bal = computed.balance[m];
      body += '<td class="sheet__computed"><span class="' + (bal < 0 ? "is-negative" : "is-positive") + '">' + Format.money(bal) + '</span></td>';
      body += "</tr>";
    });
    document.getElementById("sheet-tbody").innerHTML = body;

    wireMonthRows();
    wireCells();
    wireColHeads();
    renderCumulative();
    renderHero();
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

  function wireMonthRows() {
    document.querySelectorAll("[data-month-remove]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var row = parseInt(btn.getAttribute("data-month-remove"), 10);
        if (row === 0) removeFirstMonth(); else removeLastMonth();
      });
    });
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
    setHint("");
    loadAll().then(render);
  }

  global.SheetView = { mount: mount, show: show };
})(window);
