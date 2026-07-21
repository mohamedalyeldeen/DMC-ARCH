const nodemailer = require('nodemailer');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.office365.com',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false, // STARTTLS on port 587
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  return transporter;
}

// Never let an email failure break the request that triggered it.
async function sendMail({ to, subject, text, html }) {
  try {
    const t = getTransporter();
    if (!t || !to) return { sent: false, reason: 'Email not configured or no recipient.' };
    await t.sendMail({
      from: `"${process.env.SMTP_FROM_NAME || 'Click'}" <${process.env.SMTP_USER}>`,
      to, subject, text, html
    });
    return { sent: true };
  } catch (e) {
    console.error('Email send failed:', e.message);
    return { sent: false, reason: e.message };
  }
}

function taskAssignedEmail({ memberName, taskTitle, description, due, assignedBy }) {
  const dueLine = due ? `Due date: ${due}` : 'No due date set';
  const subject = `New task assigned to you: ${taskTitle}`;
  const text = `Hi ${memberName},\n\n${assignedBy} assigned you a new task in Click:\n\n"${taskTitle}"\n${description ? description + '\n' : ''}\n${dueLine}\n\nLog in to Click to view and start working on it.`;
  const html = `
    <p>Hi ${memberName},</p>
    <p><b>${assignedBy}</b> assigned you a new task in Click:</p>
    <p style="font-size:15px;font-weight:600;">"${taskTitle}"</p>
    ${description ? `<p>${description}</p>` : ''}
    <p>${dueLine}</p>
    <p>Log in to Click to view and start working on it.</p>
  `;
  return { subject, text, html };
}

module.exports = { sendMail, taskAssignedEmail };
