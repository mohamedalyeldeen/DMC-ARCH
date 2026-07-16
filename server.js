// مسار استقبال لقطة الاستعادة (Restore Snapshot)
app.post('/api/tasks/restore-snapshot', async (req, res) => {
    try {
        const { tasks } = req.body;
        
        if (!tasks || !Array.isArray(tasks)) {
            return res.status(400).json({ error: "بيانات اللقطة غير صالحة" });
        }
        
        // هنا نقوم باستدعاء دالة تحديث شامل من ملف sheets.js الخاص بك
        // سنقوم بكتابة دالة في sheets.js تقوم بمسح البيانات القديمة وإعادة كتابة اللقطة المستلمة
        const { updateAllTasks } = require('./lib/sheets'); // افترضنا وجود هذه الدالة
        
        await updateAllTasks(tasks);
        
        res.status(200).json({ success: true, message: "تمت استعادة اللقطة بنجاح في قاعدة البيانات" });
    } catch (error) {
        console.error("Error restoring snapshot:", error);
        res.status(500).json({ error: "فشل السيرفر في استعادة اللقطة السابقة" });
    }
});