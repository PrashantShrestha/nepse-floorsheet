const fs = require('fs');
const { google } = require('googleapis');
const path = require('path');

// Load service account credentials
const auth = new google.auth.GoogleAuth({
  keyFile: 'service-account.json', // path to your downloaded JSON file
  scopes: ['https://www.googleapis.com/auth/drive.file'],
});

async function uploadToDrive() {
  const authClient = await auth.getClient();
  const drive = google.drive({ version: 'v3', auth: authClient });

  const fileName = fs.readdirSync('./').find(f => f.endsWith('.csv')); // pick the .csv
  const filePath = path.join(__dirname, fileName);

  // Check if the DRIVE_FOLDER_ID is set as an environment variable
  const driveFolderId = process.env.DRIVE_FOLDER_ID || '1l3pzHWiS6zdUCX_AXssQsKGhuuo2Xe90'; // default ID

  const fileMetadata = {
    name: fileName,
    parents: [driveFolderId],
    // this is parents: ['NEPSE Floor Sheets'], // optional: place it in specific folder replaced by parents: ['1l3pzHWiS6zdUCX_AXssQsKGhuuo2Xe90'], // <- actual folder ID
    //parents: ['1l3pzHWiS6zdUCX_AXssQsKGhuuo2Xe90'], // <- actual folder ID
    //parents: [process.env.DRIVE_FOLDER_ID], //To avoid hardcoding:
    
  };

  const media = {
    mimeType: 'text/csv',
    body: fs.createReadStream(filePath),
  };

  const res = await drive.files.create({
    resource: fileMetadata,
    media,
    fields: 'id',
  });

  console.log(`✅ Uploaded file. ID: ${res.data.id}`);
}

uploadToDrive().catch(console.error);
