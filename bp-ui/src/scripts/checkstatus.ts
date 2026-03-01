const tx= "INSTERT"

const response = await fetch('https://testnet.across.to/api/deposit/status?depositTxnRef='+tx, {
    method: 'GET',
    headers: {
      "Accept": "*/*"
    },
});

const data = await response.json();
console.log("Response data:", data);