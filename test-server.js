const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Простой тест
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Qrawlly Bot Test</title></head>
      <body>
        <h1>🚀 Qrawlly Bot работает!</h1>
        <p>Сервер запущен на порту ${PORT}</p>
        <p>Время: ${new Date().toLocaleString()}</p>
        <h2>🧪 Тесты:</h2>
        <ul>
          <li><a href="/api/test">API Test</a></li>
          <li><a href="/webapp">Web App</a></li>
        </ul>
      </body>
    </html>
  `);
});

app.get('/api/test', (req, res) => {
  res.json({ 
    success: true, 
    message: 'API работает!',
    timestamp: new Date().toISOString(),
    port: PORT
  });
});

app.get('/webapp', (req, res) => {
  res.send(`
    <html>
      <head><title>Web App Test</title></head>
      <body>
        <h1>📱 Web App Test</h1>
        <p>Web App интерфейс работает!</p>
        <button onclick="testAPI()">Тест API</button>
        <div id="result"></div>
        <script>
          async function testAPI() {
            try {
              const response = await fetch('/api/test');
              const data = await response.json();
              document.getElementById('result').innerHTML = 
                '<pre>' + JSON.stringify(data, null, 2) + '</pre>';
            } catch (error) {
              document.getElementById('result').innerHTML = 
                '<p style="color: red;">Ошибка: ' + error.message + '</p>';
            }
          }
        </script>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`🚀 Тестовый сервер запущен на порту ${PORT}`);
  console.log(`📱 Откройте: http://localhost:${PORT}`);
});

module.exports = app;
