const { app } = require("electron");
app.whenReady().then(() => { console.log("READY ok"); app.exit(0); });
