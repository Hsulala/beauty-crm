const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

// LINE webhook 簽章驗證用的 middleware（確保請求真的來自 LINE，不是隨便誰打的）
const middleware = line.middleware({
  channelSecret: config.channelSecret,
});

function liffUrl(servicePath = '') {
  const liffId = process.env.LIFF_ID;
  return `https://liff.line.me/${liffId}${servicePath}`;
}

async function replyText(replyToken, text) {
  return client.replyMessage({ replyToken, messages: [{ type: 'text', text }] });
}

async function replyServiceMenu(replyToken, services) {
  const items = services.map((s) => ({
    type: 'action',
    action: { type: 'message', label: s.name, text: s.name },
  }));
  return client.replyMessage({
    replyToken,
    messages: [
      {
        type: 'text',
        text: '哈囉～歡迎預約妍序 Skin🤍\n請問想預約什麼療程呢？',
        quickReply: { items },
      },
    ],
  });
}

// 用按鈕樣板（Buttons Template）取代純文字網址，聊天室裡會顯示成一顆可以點的按鈕，
// 而不是一段藍色底線的網址文字，感覺更像「點一下就開始預約」而不是「點一個連結」。
async function replyBookingLink(replyToken, serviceName) {
  const url = liffUrl(`?service=${encodeURIComponent(serviceName)}`);
  return client.replyMessage({
    replyToken,
    messages: [
      {
        type: 'template',
        altText: `點此預約「${serviceName}」`,
        template: {
          type: 'buttons',
          text: `好的！已為您選好「${serviceName}」\n點下方按鈕選擇方便的時段吧`,
          actions: [{ type: 'uri', label: '立即預約', uri: url }],
        },
      },
    ],
  });
}

// 直接開預約頁（不預選療程），讓客人在 LIFF 頁面裡一次選療程＋時段，省掉多一次來回
async function replyBookingUrl(replyToken) {
  const url = liffUrl();
  return client.replyMessage({
    replyToken,
    messages: [
      {
        type: 'template',
        altText: '點此開始預約妍序 Skin',
        template: {
          type: 'buttons',
          text: '哈囉～歡迎預約妍序 Skin🤍\n點下方按鈕選擇療程與方便的時段',
          actions: [{ type: 'uri', label: '立即預約', uri: url }],
        },
      },
    ],
  });
}

async function pushText(lineUserId, text) {
  return client.pushMessage({ to: lineUserId, messages: [{ type: 'text', text }] });
}

// 推播一張圖片訊息（例如療程前/後須知），originalContentUrl 是完整原圖，
// previewImageUrl 是聊天室裡縮圖用的小圖，兩者都必須是外部可連到的 https 網址。
async function pushImage(lineUserId, originalContentUrl, previewImageUrl) {
  return client.pushMessage({
    to: lineUserId,
    messages: [{ type: 'image', originalContentUrl, previewImageUrl: previewImageUrl || originalContentUrl }],
  });
}

module.exports = { client, middleware, liffUrl, replyText, replyServiceMenu, replyBookingLink, replyBookingUrl, pushText, pushImage };
