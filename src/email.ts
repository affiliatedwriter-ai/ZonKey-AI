// worker/src/email.ts

export async function sendLicenseEmail(
  email: string, 
  licenseKey: string, 
  planName: string, 
  resendApiKey: string
): Promise<boolean> {
  
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; padding: 20px; line-height: 1.6;">
      <h2>🎉 Thank you for your purchase!</h2>
      <p>Your subscription for <strong>${planName}</strong> is now active.</p>
      
      <div style="background: #f4f4f4; padding: 15px; border-radius: 8px; margin: 20px 0;">
        <p style="margin:0; font-size: 14px; color: #555;">Your License Key:</p>
        <code style="font-size: 18px; font-weight: bold; color: #333; display: block; margin-top: 5px;">${licenseKey}</code>
      </div>

      <p><strong>How to use:</strong></p>
      <ol>
        <li>Open 
Zonkey AI Extension on Amazon.</li>
        <li>Click on extension icon.</li>
        <li>Paste the license key above to activate.</li>
      </ol>
      
      <p>If you have any questions, reply to this email.</p>
      <p>Best regards,<br>Zonkey AI Team</p>
    </div>
  `;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Zonkey AI <support@affiliatedwriter.com>', // আপনার ভেরিফাইড ডোমেইন থাকে সেটি দিন (যেমন: support@yourdomain.com)
        to: email,
        subject: `Your License Key for ${planName}`,
        html: htmlContent
      })
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Resend Error:', err);
      return false;
    }
    
    return true;
  } catch (e) {
    console.error('Email Send Failed:', e);
    return false;
  }
}
