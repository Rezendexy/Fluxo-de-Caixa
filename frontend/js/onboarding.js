(function (global) {
  "use strict";

  var Fi = global.Finance;
  var Format = global.Format;
  var rows = []; // {id, nameEl, valueEl, wrapEl}
  var rowSeq = 0;
  var currentUser = null;
  var onComplete = null;

  function moneyMaskBlur(el) {
    var v = Format.parseNumber(el.value);
    el.value = isFinite(v) ? Format.fmtNum.format(v) : "";
  }

  function setStep(n) {
    [1, 2, 3].forEach(function (i) {
      document.getElementById("step-" + i).hidden = n !== i;
      var tab = document.getElementById("step-tab-" + i);
      tab.classList.toggle("is-active", n === i);
      tab.classList.toggle("is-done", n > i);
    });
    if (n === 3) updatePeriodPreview();
  }

  function setFieldError(id, msg) {
    var box = document.getElementById(id + "-box");
    var err = document.getElementById(id + "-err");
    if (box) box.classList.toggle("is-error", !!msg);
    if (err) { err.textContent = msg || ""; err.classList.toggle("is-on", !!msg); }
  }

  function addRow(name) {
    rowSeq++;
    var wrap = document.createElement("div");
    wrap.className = "ob-row";
    wrap.innerHTML =
      '<input type="text" class="ob-row__name" placeholder="Nome do gasto" value="' + Format.esc(name || "") + '">' +
      '<div class="ob-row__value">' +
      '<span class="input__affix">R$</span>' +
      '<input type="text" inputmode="decimal" class="ob-row__amount" placeholder="0,00">' +
      '</div>' +
      '<button type="button" class="ob-row__remove" aria-label="Remover gasto">&times;</button>';

    var nameEl = wrap.querySelector(".ob-row__name");
    var valueEl = wrap.querySelector(".ob-row__amount");
    valueEl.addEventListener("blur", function () { moneyMaskBlur(valueEl); });
    wrap.querySelector(".ob-row__remove").addEventListener("click", function () {
      rows = rows.filter(function (r) { return r.wrapEl !== wrap; });
      wrap.remove();
    });

    document.getElementById("ob-rows").appendChild(wrap);
    rows.push({ id: rowSeq, nameEl: nameEl, valueEl: valueEl, wrapEl: wrap });
    if (!name) nameEl.focus();
  }

  function resetRows() {
    rows = [];
    document.getElementById("ob-rows").innerHTML = "";
  }

  /* ============ etapa 3: período ============ */
  function periodMonths() {
    var v = parseInt(document.getElementById("ob-period").value, 10);
    return isFinite(v) && v > 0 ? Math.min(v, 600) : NaN;
  }

  function updatePeriodPreview() {
    var preview = document.getElementById("ob-period-preview");
    var n = periodMonths();
    if (!isFinite(n)) { preview.innerHTML = "&nbsp;"; return; }
    var start = Fi.todayKey();
    var end = Fi.addMonths(start, n);
    var count = Fi.monthRange(start, end).length;
    preview.textContent = "Vai começar em " + Format.capitalize(Fi.monthLabel(start)) + " de " + Fi.yearOf(start) +
      " e terminar em " + Format.capitalize(Fi.monthLabel(end)) + " de " + Fi.yearOf(end) +
      " (" + count + " meses na planilha).";
  }

  function mount() {
    document.querySelectorAll('#step-1 [data-fill]').forEach(function (chip) {
      chip.addEventListener("click", function () {
        var target = document.getElementById(chip.getAttribute("data-fill"));
        target.value = Format.fmtNum.format(parseFloat(chip.getAttribute("data-value")));
        setFieldError("ob-income", "");
      });
    });
    document.getElementById("ob-income").addEventListener("blur", function (e) { moneyMaskBlur(e.target); });

    document.getElementById("ob-step1-next").addEventListener("click", function () {
      var v = Format.parseNumber(document.getElementById("ob-income").value);
      if (!isFinite(v) || v <= 0) {
        setFieldError("ob-income", "Informe uma receita maior que zero.");
        return;
      }
      setFieldError("ob-income", "");
      setStep(2);
    });

    document.getElementById("ob-step2-back").addEventListener("click", function () { setStep(1); });

    document.querySelectorAll("#ob-suggestions .chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        var name = chip.getAttribute("data-cat");
        var already = rows.some(function (r) { return r.nameEl.value.trim().toLowerCase() === name.toLowerCase(); });
        if (already) return;
        addRow(name);
      });
    });

    document.getElementById("ob-add-row").addEventListener("click", function () { addRow(""); });

    document.getElementById("ob-step2-next").addEventListener("click", function () {
      var hasAny = rows.some(function (r) { return r.nameEl.value.trim(); });
      if (!hasAny) {
        document.getElementById("ob-rows-err").textContent = "Adicione pelo menos um gasto para continuar.";
        document.getElementById("ob-rows-err").classList.add("is-on");
        return;
      }
      document.getElementById("ob-rows-err").classList.remove("is-on");
      setStep(3);
    });

    document.querySelectorAll('#step-3 [data-fill]').forEach(function (chip) {
      chip.addEventListener("click", function () {
        var target = document.getElementById(chip.getAttribute("data-fill"));
        target.value = chip.getAttribute("data-value");
        setFieldError("ob-period", "");
        updatePeriodPreview();
      });
    });
    document.getElementById("ob-period").addEventListener("input", function () {
      setFieldError("ob-period", "");
      updatePeriodPreview();
    });

    document.getElementById("ob-step3-back").addEventListener("click", function () { setStep(2); });
    document.getElementById("ob-step3-finish").addEventListener("click", finish);
  }

  function finish() {
    var n = periodMonths();
    if (!isFinite(n)) {
      setFieldError("ob-period", "Informe um número de meses maior que zero.");
      return;
    }
    setFieldError("ob-period", "");

    var income = Format.parseNumber(document.getElementById("ob-income").value);
    var categories = [];

    rows.forEach(function (r) {
      var name = r.nameEl.value.trim();
      if (!name) return; // linha em branco, ignora
      var amount = Format.parseNumber(r.valueEl.value);
      categories.push({ name: name, monthly_estimate: isFinite(amount) && amount > 0 ? amount : 0 });
    });

    if (categories.length === 0) {
      setStep(2);
      document.getElementById("ob-rows-err").textContent = "Adicione pelo menos um gasto para continuar.";
      document.getElementById("ob-rows-err").classList.add("is-on");
      return;
    }

    var btn = document.getElementById("ob-step3-finish");
    btn.disabled = true;
    btn.textContent = "Salvando…";

    var startMonth = Fi.todayKey();
    var endMonth = Fi.addMonths(startMonth, n);

    // upsert (não update): se o gatilho do banco que cria a linha em
    // "profiles" no cadastro ainda não rodou, um update simples casaria
    // zero linhas — sem erro nenhum — e a gente voltaria pra etapa 1 sem
    // explicação nenhuma. upsert cria a linha se ela não existir.
    global.DB.client.from("profiles")
      .upsert({ id: currentUser.id, monthly_income: income, onboarding_completed: true, start_month: startMonth, plan_end_month: endMonth }, { onConflict: "id" })
      .select()
      .then(function (res) {
        if (res.error || !res.data || !res.data.length) {
          return fail(res.error || { message: "o perfil não foi salvo (nenhuma linha retornada)." });
        }
        return global.DB.client.from("categories").insert(
          categories.map(function (c, i) {
            return { user_id: currentUser.id, name: c.name, monthly_estimate: c.monthly_estimate, sort_order: i };
          })
        );
      })
      .then(function (res) {
        if (!res) return;
        if (res.error) { return fail(res.error); }
        btn.disabled = false;
        btn.textContent = "Concluir e ver meu fluxo de caixa";
        if (onComplete) onComplete();
      });

    function fail(error) {
      btn.disabled = false;
      btn.textContent = "Concluir e ver meu fluxo de caixa";
      document.getElementById("ob-period-err").textContent = "Não deu para salvar agora: " + error.message;
      document.getElementById("ob-period-err").classList.add("is-on");
    }
  }

  function show(user, profile, doneCallback) {
    currentUser = user;
    onComplete = doneCallback;
    resetRows();
    document.getElementById("ob-income").value = profile && profile.monthly_income
      ? Format.fmtNum.format(profile.monthly_income) : "";
    document.getElementById("ob-period").value = "12";
    setFieldError("ob-income", "");
    setFieldError("ob-period", "");
    document.getElementById("ob-rows-err").classList.remove("is-on");
    setStep(1);
  }

  global.OnboardingView = { mount: mount, show: show };
})(window);
