(function (global) {
  "use strict";

  var panes = ["login", "signup", "forgot", "newpass"];

  function showPane(name) {
    panes.forEach(function (p) {
      var el = document.getElementById("pane-" + p);
      if (el) el.hidden = p !== name;
    });
    var isTabbed = name === "login" || name === "signup";
    document.getElementById("tab-login").setAttribute("aria-selected", String(name === "login"));
    document.getElementById("tab-signup").setAttribute("aria-selected", String(name === "signup"));
    document.getElementById("tab-login").tabIndex = name === "login" ? 0 : -1;
    document.getElementById("tab-signup").tabIndex = name === "signup" ? 0 : -1;
    document.querySelector(".auth__card .tabs").style.display = isTabbed ? "" : "none";
  }

  function setBoxError(id, msg) {
    var box = document.getElementById(id + "-box");
    if (box) box.classList.toggle("is-error", !!msg);
  }
  function setMsg(id, msg) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg || "";
    el.classList.toggle("is-on", !!msg);
  }
  function clearMsgs() {
    ["login-err", "signup-err", "forgot-err", "forgot-ok", "newpass-err"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) { el.textContent = ""; el.classList.remove("is-on"); }
    });
    ["login-email", "login-password", "signup-name", "signup-email", "signup-password", "forgot-email"].forEach(function (id) {
      setBoxError(id, "");
    });
  }

  function setLoading(btnId, loading, label, loadingLabel) {
    var btn = document.getElementById(btnId);
    if (!btn) return;
    btn.disabled = loading;
    btn.textContent = loading ? loadingLabel : label;
  }

  function friendlyError(msg) {
    if (!msg) return "Algo deu errado. Tente de novo.";
    if (/invalid login credentials/i.test(msg)) return "E-mail ou senha incorretos.";
    if (/user already registered/i.test(msg)) return "Este e-mail já tem uma conta. Use a aba Entrar.";
    if (/email not confirmed/i.test(msg)) return "Confirme seu e-mail antes de entrar. Veja sua caixa de entrada.";
    if (/password should be at least/i.test(msg)) return "A senha precisa ter pelo menos 6 caracteres.";
    if (/rate limit/i.test(msg)) return "Muitas tentativas. Espere um instante e tente de novo.";
    return msg;
  }

  function mount() {
    document.getElementById("tab-login").addEventListener("click", function () { clearMsgs(); showPane("login"); });
    document.getElementById("tab-signup").addEventListener("click", function () { clearMsgs(); showPane("signup"); });
    document.getElementById("btn-forgot").addEventListener("click", function () {
      clearMsgs();
      var email = document.getElementById("login-email").value.trim();
      if (email) document.getElementById("forgot-email").value = email;
      showPane("forgot");
    });
    document.getElementById("btn-forgot-back").addEventListener("click", function () { clearMsgs(); showPane("login"); });

    document.getElementById("pane-login").addEventListener("submit", function (e) {
      e.preventDefault();
      clearMsgs();
      var email = document.getElementById("login-email").value.trim();
      var password = document.getElementById("login-password").value;
      if (!email) { setBoxError("login-email", true); setMsg("login-err", "Informe seu e-mail."); return; }
      if (!password) { setBoxError("login-password", true); setMsg("login-err", "Informe sua senha."); return; }
      setLoading("login-submit", true, "Entrar", "Entrando…");
      global.DB.client.auth.signInWithPassword({ email: email, password: password }).then(function (res) {
        setLoading("login-submit", false, "Entrar", "Entrando…");
        if (res.error) {
          setBoxError("login-email", true); setBoxError("login-password", true);
          setMsg("login-err", friendlyError(res.error.message));
        }
      });
    });

    document.getElementById("pane-signup").addEventListener("submit", function (e) {
      e.preventDefault();
      clearMsgs();
      var name = document.getElementById("signup-name").value.trim();
      var email = document.getElementById("signup-email").value.trim();
      var password = document.getElementById("signup-password").value;
      if (!name) { setBoxError("signup-name", true); setMsg("signup-err", "Informe seu nome completo."); return; }
      if (!email) { setBoxError("signup-email", true); setMsg("signup-err", "Informe seu e-mail."); return; }
      if (password.length < 6) { setBoxError("signup-password", true); setMsg("signup-err", "A senha precisa ter pelo menos 6 caracteres."); return; }
      setLoading("signup-submit", true, "Criar minha conta", "Criando conta…");
      global.DB.client.auth.signUp({ email: email, password: password, options: { data: { full_name: name } } }).then(function (res) {
        setLoading("signup-submit", false, "Criar minha conta", "Criando conta…");
        if (res.error) {
          setMsg("signup-err", friendlyError(res.error.message));
          return;
        }
        // onAuthStateChange já assume daqui; upsert (não update) garante o
        // nome no perfil mesmo que o gatilho do banco que cria a linha em
        // "profiles" ainda não tenha rodado (um update simples casaria zero
        // linhas nesse caso, sem erro nenhum, e o nome nunca seria salvo).
        if (res.data && res.data.user) {
          global.DB.client.from("profiles").upsert({ id: res.data.user.id, full_name: name }, { onConflict: "id" }).then(function () {});
        }
      });
    });

    document.getElementById("pane-forgot").addEventListener("submit", function (e) {
      e.preventDefault();
      var email = document.getElementById("forgot-email").value.trim();
      if (!email) { setBoxError("forgot-email", true); setMsg("forgot-err", "Informe seu e-mail."); return; }
      setLoading("forgot-submit", true, "Enviar link", "Enviando…");
      global.DB.client.auth.resetPasswordForEmail(email, { redirectTo: global.location.href.split("#")[0].split("?")[0] }).then(function (res) {
        setLoading("forgot-submit", false, "Enviar link", "Enviando…");
        if (res.error) { setMsg("forgot-err", friendlyError(res.error.message)); return; }
        setMsg("forgot-ok", "Pronto! Se esse e-mail tiver uma conta, um link para trocar a senha foi enviado.");
      });
    });

    document.getElementById("pane-newpass").addEventListener("submit", function (e) {
      e.preventDefault();
      var password = document.getElementById("newpass-password").value;
      if (password.length < 6) { setMsg("newpass-err", "A senha precisa ter pelo menos 6 caracteres."); return; }
      setLoading("newpass-submit", true, "Salvar nova senha", "Salvando…");
      global.DB.client.auth.updateUser({ password: password }).then(function (res) {
        setLoading("newpass-submit", false, "Salvar nova senha", "Salvando…");
        if (res.error) { setMsg("newpass-err", friendlyError(res.error.message)); return; }
        global.App.refresh();
      });
    });
  }

  function reset() {
    clearMsgs();
    document.getElementById("pane-login").reset();
    document.getElementById("pane-signup").reset();
    showPane("login");
  }

  function showRecovery() {
    clearMsgs();
    showPane("newpass");
  }

  global.AuthView = { mount: mount, reset: reset, showRecovery: showRecovery };
})(window);
