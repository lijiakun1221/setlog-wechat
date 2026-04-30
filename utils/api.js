const app = getApp();

function baseUrl() {
  return app.globalData.baseUrl;
}

function request(path, method = "GET", data = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      "content-type": "application/json"
    };
    const sessionId = app.globalData.sessionId;
    if (sessionId) {
      headers["x-session-id"] = sessionId;
    }
    wx.request({
      url: `${baseUrl()}${path}`,
      method,
      data,
      header: headers,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
          return;
        }
        reject(new Error(res.data?.error || `HTTP ${res.statusCode}`));
      },
      fail(err) {
        reject(err);
      }
    });
  });
}

function uploadFile(uploadUrl, filePath) {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${baseUrl()}${uploadUrl}`,
      filePath,
      name: "file",
      success(res) {
        const data = res.data ? JSON.parse(res.data) : {};
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
          return;
        }
        reject(new Error(data.error || `HTTP ${res.statusCode}`));
      },
      fail(err) {
        reject(err);
      }
    });
  });
}

module.exports = {
  request,
  uploadFile
};
