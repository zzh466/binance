const elements = {
  loginForm: document.querySelector("#loginForm"),
  userName: document.querySelector("#userName"),
  password: document.querySelector("#password"),
  loginButton: document.querySelector("#loginButton"),
  loginStatus: document.querySelector("#loginStatus"),
  clientVersion: document.querySelector("#clientVersion"),
  deviceIdentity: document.querySelector("#deviceIdentity"),
  accountDialog: document.querySelector("#accountDialog"),
  accountForm: document.querySelector("#accountForm"),
  accountList: document.querySelector("#accountList"),
  accountStatus: document.querySelector("#accountStatus"),
  cancelAccountButton: document.querySelector("#cancelAccountButton"),
  confirmAccountButton: document.querySelector("#confirmAccountButton"),
};

let selectionToken = "";

function formatError(result) {
  return result?.error?.message || "登录失败，请检查用户名、密码和网络。";
}

function setLoginBusy(busy) {
  elements.loginButton.disabled = busy;
  elements.userName.disabled = busy;
  elements.password.disabled = busy;
  elements.loginButton.textContent = busy ? "登录中…" : "登录";
}

function showAccountSelection(result) {
  selectionToken = result.selectionToken;
  elements.accountList.replaceChildren();
  result.accounts.forEach((account, index) => {
    const label = document.createElement("label");
    label.className = "account-option";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "accountKey";
    radio.value = account.accountKey;
    radio.checked = index === 0;
    const name = document.createElement("span");
    name.textContent = account.futureUserName;
    label.append(radio, name);
    elements.accountList.append(label);
  });
  elements.accountStatus.textContent = "";
  elements.accountDialog.showModal();
}

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setLoginBusy(true);
  elements.loginStatus.className = "status";
  elements.loginStatus.textContent = "正在登录管理端并读取账号信息…";
  try {
    const result = await window.managerLogin.login({
      userNm: elements.userName.value.trim(),
      userPwd: elements.password.value,
    });
    if (!result.ok) {
      elements.loginStatus.textContent = formatError(result);
      return;
    }
    if (result.data.requiresSelection) {
      elements.loginStatus.textContent = "请选择本次要使用的交易账号。";
      showAccountSelection(result.data);
      return;
    }
    elements.loginStatus.className = "status success";
    elements.loginStatus.textContent = "登录成功，正在进入主窗口…";
  } catch (error) {
    elements.loginStatus.textContent = error?.message || "登录窗口已关闭。";
  } finally {
    setLoginBusy(false);
  }
});

elements.accountForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const accountKey = new FormData(elements.accountForm).get("accountKey");
  if (!accountKey) {
    elements.accountStatus.textContent = "请选择一个交易账号。";
    return;
  }
  elements.confirmAccountButton.disabled = true;
  elements.cancelAccountButton.disabled = true;
  elements.accountStatus.textContent = "正在读取交易配置并进入主窗口…";
  try {
    const result = await window.managerLogin.selectAccount({
      selectionToken,
      accountKey,
    });
    if (!result.ok) {
      elements.accountStatus.textContent = formatError(result);
      return;
    }
    elements.accountStatus.className = "status success";
    elements.accountStatus.textContent = "账号已选择，正在进入主窗口…";
  } catch (error) {
    elements.accountStatus.textContent = error?.message || "登录窗口已关闭。";
  } finally {
    elements.confirmAccountButton.disabled = false;
    elements.cancelAccountButton.disabled = false;
  }
});

elements.cancelAccountButton.addEventListener("click", () => {
  selectionToken = "";
  elements.accountDialog.close();
  elements.password.focus();
});

window.managerLogin.context().then((result) => {
  if (!result.ok) {
    elements.clientVersion.textContent = "未知";
    elements.deviceIdentity.textContent = formatError(result);
    return;
  }
  elements.clientVersion.textContent = result.data.clientVersion;
  elements.deviceIdentity.textContent =
    `${result.data.networkInterface} / ${result.data.userMAC}`;
}).catch((error) => {
  elements.deviceIdentity.textContent = error?.message || "读取失败";
});
