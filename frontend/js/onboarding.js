(function (global) {
  "use strict";

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
    document.getElementById("step-1").hidden = n !== 1;
    document.getElementById("step-2").hidden = n !== 2;
    document.getElementById("step-tab-1").classList.toggle("is-active", n === 1);
    document.getElementById("step-tab-1").classList.toggle("is-done", n > 1);
    document.getElementById("step-tab-2").classList.toggle("is-active", n === 2);
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
      '<button type="button" class="ob-row__remove" aria-label="Remover gasto">&times;</button>';

    var nameEl = wrap.querySelector(".ob-row__name");
    wrap.querySelector(".ob-row__remove").addEventListener("click", function () {
      rows = rows.filter(function (r) { return r.wrapEl !== wrap; });
      wrap.remove();
    });

    document.getElementById("ob-rows").appendChild(wrap);
    rows.push({ id: rowSeq, nameEl: nameEl, wrapEl: wrap });
    if (!name) nameEl.focus();
  }

  function resetRows() {
    rows = [];
    document.getElementById("ob-rows").innerHTML = "";
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

    document.getElementById("ob-step2-finish").addEventListener("click", finish);
  }

  function finish() {
    var income = Format.parseNumber(document.getElementById("ob-income").value);
    var categories = [];

    rows.forEach(function (r) {
      var name = r.nameEl.value.trim();
      if (!name) return; // linha em branco, ignora
      categories.push({ name: name, monthly_estimate: 0 });
    });

    if (categories.length === 0) {
      document.getElementById("ob-rows-err").textContent = "Adicione pelo menos um gasto para continuar.";
      document.getElementById("ob-rows-err").classList.add("is-on");
      return;
    }
    document.getElementById("ob-rows-err").classList.remove("is-on");

    var btn = document.getElementById("ob-step2-finish");
    btn.disabled = true;
    btn.textContent = "Salvando…";

    var today = new Date();
    var startMonth = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-01";

    global.DB.client.from("profiles")
      .update({ monthly_income: income, onboarding_completed: true, start_month: startMonth })
      .eq("id", currentUser.id)
      .then(function (res) {
        if (res.error) { return fail(res.error); }
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
      document.getElementById("ob-rows-err").textContent = "Não deu para salvar agora: " + error.message;
      document.getElementById("ob-rows-err").classList.add("is-on");
    }
  }

  function show(user, profile, doneCallback) {
    currentUser = user;
    onComplete = doneCallback;
    resetRows();
    document.getElementById("ob-income").value = profile && profile.monthly_income
      ? Format.fmtNum.format(profile.monthly_income) : "";
    setFieldError("ob-income", "");
    document.getElementById("ob-rows-err").classList.remove("is-on");
    setStep(1);
  }

  global.OnboardingView = { mount: mount, show: show };
})(window);
