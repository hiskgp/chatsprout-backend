import { Router } from 'express';
const router = Router();
router.get('/', (req, res) => {
  res.json([
    { id: 1, name: 'Srikeerthi', phone: '+91 98765 43210', lastMessage: 'Hello da!', avatar: 'SK' },
    { id: 2, name: 'Customer A', phone: '+91 87654 32109', lastMessage: 'Order ready?', avatar: 'CA' },
    { id: 3, name: 'Test User', phone: '+91 76543 21098', lastMessage: 'Thanks!', avatar: 'TU' }
  ]);
});
export default router;




// import { Router } from 'express';
// import { z } from 'zod';
// import multer from 'multer';
// import { parse } from 'csv-parse/sync';
// import { stringify } from 'csv-stringify/sync';
// import { authMiddleware } from '../../middleware/auth';
// import { hasPermission } from '../../middleware/rbac';
// import { asyncHandler } from '../../middleware/error';
// import { prisma } from '../../utils/prisma';
// import { cache } from '../../services/redis.service';
// import { BadRequestError, NotFoundError, ConflictError } from '../../utils/errors';
// import { logger } from '../../utils/logger';

// const router = Router();
// const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 } }); // 10MB

// // All contact routes require authentication
// router.use(authMiddleware);

// // Validation schemas
// const createContactSchema = z.object({
//   name: z.string().min(1).max(100),
//   phoneNumber: z.string().regex(/^\+?[1-9]\d{1,14}$/, 'Invalid phone number'),
//   email: z.string().email().optional().nullable(),
//   tags: z.array(z.string()).default([]),
//   customFields: z.record(z.any()).default({}),
//   notes: z.string().max(1000).optional(),
// });

// const updateContactSchema = createContactSchema.partial();

// const bulkTagSchema = z.object({
//   contactIds: z.array(z.string().uuid()).min(1).max(1000),
//   tags: z.array(z.string()).min(1),
//   action: z.enum(['add', 'remove', 'replace']),
// });

// const importContactsSchema = z.object({
//   skipDuplicates: z.boolean().default(true),
//   addTags: z.array(z.string()).default([]),
// });

// /**
//  * GET /api/contacts
//  * Get all contacts with filters, search, pagination
//  */
// router.get(
//   '/',
//   hasPermission('contacts.view'),
//   asyncHandler(async (req, res) => {
//     const { search, tags, status, page = '1', limit = '50' } = req.query;

//     const pageNum = parseInt(page as string);
//     const limitNum = Math.min(parseInt(limit as string), 100); // Max 100 per page
//     const skip = (pageNum - 1) * limitNum;

//     // Build where clause
//     const where: any = { orgId: req.orgId };

//     if (search) {
//       where.OR = [
//         { name: { contains: search as string, mode: 'insensitive' } },
//         { phoneNumber: { contains: search as string } },
//         { email: { contains: search as string, mode: 'insensitive' } },
//       ];
//     }

//     if (tags) {
//       const tagArray = (tags as string).split(',');
//       where.tags = { hasSome: tagArray };
//     }

//     if (status) {
//       where.status = status;
//     }

//     // Get contacts with pagination
//     const [contacts, total] = await Promise.all([
//       prisma.contact.findMany({
//         where,
//         include: {
//           assignedTo: {
//             select: { id: true, name: true, email: true },
//           },
//           _count: {
//             select: { conversations: true, orders: true },
//           },
//         },
//         orderBy: { updatedAt: 'desc' },
//         skip,
//         take: limitNum,
//       }),
//       prisma.contact.count({ where }),
//     ]);

//     res.json({
//       success: true,
//       data: contacts,
//       pagination: {
//         page: pageNum,
//         limit: limitNum,
//         total,
//         totalPages: Math.ceil(total / limitNum),
//       },
//     });
//   })
// );

// /**
//  * GET /api/contacts/:id
//  * Get single contact with full details
//  */
// router.get(
//   '/:id',
//   hasPermission('contacts.view'),
//   asyncHandler(async (req, res) => {
//     const { id } = req.params;

//     const contact = await prisma.contact.findFirst({
//       where: { id, orgId: req.orgId },
//       include: {
//         assignedTo: {
//           select: { id: true, name: true, email: true },
//         },
//         conversations: {
//           take: 5,
//           orderBy: { lastMessageAt: 'desc' },
//           select: {
//             id: true,
//             status: true,
//             lastMessageAt: true,
//             unreadCount: true,
//           },
//         },
//         orders: {
//           take: 5,
//           orderBy: { createdAt: 'desc' },
//           select: {
//             id: true,
//             orderNumber: true,
//             status: true,
//             total: true,
//             createdAt: true,
//           },
//         },
//       },
//     });

//     if (!contact) {
//       throw new NotFoundError('Contact not found');
//     }

//     res.json({
//       success: true,
//       data: contact,
//     });
//   })
// );

// /**
//  * POST /api/contacts
//  * Create new contact
//  */
// router.post(
//   '/',
//   hasPermission('contacts.create'),
//   asyncHandler(async (req, res) => {
//     const validated = createContactSchema.parse(req.body);

//     // Check for duplicate phone number in org
//     const existing = await prisma.contact.findFirst({
//       where: {
//         orgId: req.orgId,
//         phoneNumber: validated.phoneNumber,
//       },
//     });

//     if (existing) {
//       throw new ConflictError('Contact with this phone number already exists');
//     }

//     const contact = await prisma.contact.create({
//       data: {
//        ...validated,
//         orgId: req.orgId!,
//         source: 'MANUAL',
//         createdById: req.user!.id,
//       },
//     });

//     // Clear cache
//     await cache.delPattern(`contacts:${req.orgId}:*`);

//     logger.info(`Contact created: ${contact.id}`, { orgId: req.orgId });

//     res.status(201).json({
//       success: true,
//       data: contact,
//     });
//   })
// );

// /**
//  * PATCH /api/contacts/:id
//  * Update contact
//  */
// router.patch(
//   '/:id',
//   hasPermission('contacts.create'),
//   asyncHandler(async (req, res) => {
//     const { id } = req.params;
//     const validated = updateContactSchema.parse(req.body);

//     // Check if contact exists and belongs to org
//     const existing = await prisma.contact.findFirst({
//       where: { id, orgId: req.orgId },
//     });

//     if (!existing) {
//       throw new NotFoundError('Contact not found');
//     }

//     // Check for phone number conflict if updating
//     if (validated.phoneNumber && validated.phoneNumber!== existing.phoneNumber) {
//       const duplicate = await prisma.contact.findFirst({
//         where: {
//           orgId: req.orgId,
//           phoneNumber: validated.phoneNumber,
//           id: { not: id },
//         },
//       });

//       if (duplicate) {
//         throw new ConflictError('Phone number already in use');
//       }
//     }

//     const contact = await prisma.contact.update({
//       where: { id },
//       data: validated,
//     });

//     // Clear cache
//     await cache.delPattern(`contacts:${req.orgId}:*`);

//     logger.info(`Contact updated: ${id}`);

//     res.json({
//       success: true,
//       data: contact,
//     });
//   })
// );

// /**
//  * DELETE /api/contacts/:id
//  * Delete contact (soft delete)
//  */
// router.delete(
//   '/:id',
//   hasPermission('contacts.delete'),
//   asyncHandler(async (req, res) => {
//     const { id } = req.params;

//     const contact = await prisma.contact.findFirst({
//       where: { id, orgId: req.orgId },
//     });

//     if (!contact) {
//       throw new NotFoundError('Contact not found');
//     }

//     await prisma.contact.update({
//       where: { id },
//       data: { status: 'ARCHIVED' },
//     });

//     logger.info(`Contact archived: ${id}`);

//     res.json({
//       success: true,
//       message: 'Contact archived successfully',
//     });
//   })
// );

// /**
//  * POST /api/contacts/bulk/tag
//  * Add/remove tags from multiple contacts
//  */
// router.post(
//   '/bulk/tag',
//   hasPermission('contacts.create'),
//   asyncHandler(async (req, res) => {
//     const { contactIds, tags, action } = bulkTagSchema.parse(req.body);

//     // Verify all contacts belong to org
//     const contacts = await prisma.contact.findMany({
//       where: {
//         id: { in: contactIds },
//         orgId: req.orgId,
//       },
//       select: { id: true, tags: true },
//     });

//     if (contacts.length!== contactIds.length) {
//       throw new BadRequestError('Some contacts not found or not accessible');
//     }

//     // Update tags based on action
//     const updates = contacts.map((contact) => {
//       let newTags: string[];

//       switch (action) {
//         case 'add':
//           newTags = Array.from(new Set([...contact.tags,...tags]));
//           break;
//         case 'remove':
//           newTags = contact.tags.filter((t) =>!tags.includes(t));
//           break;
//         case 'replace':
//           newTags = tags;
//           break;
//       }

//       return prisma.contact.update({
//         where: { id: contact.id },
//         data: { tags: newTags },
//       });
//     });

//     await Promise.all(updates);

//     logger.info(`Bulk tagged ${contactIds.length} contacts`, { action, tags });

//     res.json({
//       success: true,
//       message: `${contactIds.length} contacts updated`,
//     });
//   })
// );

// /**
//  * POST /api/contacts/import
//  * Import contacts from CSV
//  */
// router.post(
//   '/import',
//   upload.single('file'),
//   hasPermission('contacts.import'),
//   asyncHandler(async (req, res) => {
//     if (!req.file) {
//       throw new BadRequestError('CSV file required');
//     }

//     const { skipDuplicates, addTags } = importContactsSchema.parse(req.body);

//     // Parse CSV
//     const csvData = req.file.buffer.toString('utf-8');
//     const records = parse(csvData, {
//       columns: true,
//       skip_empty_lines: true,
//       trim: true,
//     });

//     if (records.length === 0) {
//       throw new BadRequestError('CSV file is empty');
//     }

//     if (records.length > 10000) {
//       throw new BadRequestError('Maximum 10,000 contacts per import');
//     }

//     // Validate and prepare contacts
//     const contacts = [];
//     const errors = [];
//     const duplicates = [];

//     for (let i = 0; i < records.length; i++) {
//       const row = records[i];
//       const rowNum = i + 2; // +2 for header and 0-index

//       try {
//         const contact = {
//           name: row.name || row.Name || row.NAME,
//           phoneNumber: row.phone || row.Phone || row.phoneNumber || row.PHONE,
//           email: row.email || row.Email || row.EMAIL || null,
//           tags: [
//            ...(row.tags? row.tags.split(',').map((t: string) => t.trim()) : []),
//           ...addTags,
//           ],
//           orgId: req.orgId!,
//           source: 'IMPORT',
//           createdById: req.user!.id,
//         };

//         // Validate
//         if (!contact.name ||!contact.phoneNumber) {
//           errors.push({ row: rowNum, error: 'Name and phone number required' });
//           continue;
//         }

//         if (!/^\+?[1-9]\d{1,14}$/.test(contact.phoneNumber)) {
//           errors.push({ row: rowNum, error: 'Invalid phone number format' });
//           continue;
//         }

//         contacts.push(contact);
//       } catch (error: any) {
//         errors.push({ row: rowNum, error: error.message });
//       }
//     }

//     // Check for existing contacts
//     const phoneNumbers = contacts.map((c) => c.phoneNumber);
//     const existing = await prisma.contact.findMany({
//       where: {
//         orgId: req.orgId,
//         phoneNumber: { in: phoneNumbers },
//       },
//       select: { phoneNumber: true },
//     });

//     const existingPhones = new Set(existing.map((c) => c.phoneNumber));

//     let toCreate = contacts;
//     if (skipDuplicates) {
//       toCreate = contacts.filter((c) => {
//         if (existingPhones.has(c.phoneNumber)) {
//           duplicates.push(c.phoneNumber);
//           return false;
//         }
//         return true;
//       });
//     } else if (existingPhones.size > 0) {
//       throw new ConflictError(`Duplicate phone numbers found: ${Array.from(existingPhones).join(', ')}`);
//     }

//     // Bulk create
//     const result = await prisma.contact.createMany({
//       data: toCreate,
//       skipDuplicates: true,
//     });

//     // Clear cache
//     await cache.delPattern(`contacts:${req.orgId}:*`);

//     logger.info(`Contacts imported: ${result.count}`, {
//       total: records.length,
//       imported: result.count,
//       errors: errors.length,
//       duplicates: duplicates.length,
//     });

//     res.json({
//       success: true,
//       data: {
//         total: records.length,
//         imported: result.count,
//         errors: errors.length,
//         duplicates: duplicates.length,
//         errorDetails: errors.slice(0, 10), // First 10 errors
//       },
//     });
//   })
// );

// /**
//  * GET /api/contacts/export
//  * Export contacts to CSV
//  */
// router.get(
//   '/export',
//   hasPermission('contacts.export'),
//   asyncHandler(async (req, res) => {
//     const { tags, status } = req.query;

//     const where: any = { orgId: req.orgId, status: 'ACTIVE' };

//     if (tags) {
//       where.tags = { hasSome: (tags as string).split(',') };
//     }

//     if (status) {
//       where.status = status;
//     }

//     const contacts = await prisma.contact.findMany({
//       where,
//       select: {
//         name: true,
//         phoneNumber: true,
//         email: true,
//         tags: true,
//         status: true,
//         createdAt: true,
//       },
//       orderBy: { createdAt: 'desc' },
//     });

//     // Convert to CSV
//     const csv = stringify(
//       contacts.map((c) => ({
//         Name: c.name,
//         Phone: c.phoneNumber,
//         Email: c.email || '',
//         Tags: c.tags.join(', '),
//         Status: c.status,
//         CreatedAt: c.createdAt.toISOString(),
//       })),
//       { header: true }
//     );

//     res.setHeader('Content-Type', 'text/csv');
//     res.setHeader('Content-Disposition', `attachment; filename=contacts-${Date.now()}.csv`);
//     res.send(csv);

//     logger.info(`Contacts exported: ${contacts.length}`, { orgId: req.orgId });
//   })
// );

// /**
//  * GET /api/contacts/tags
//  * Get all unique tags used in org
//  */
// router.get(
//   '/tags',
//   hasPermission('contacts.view'),
//   asyncHandler(async (req, res) => {
//     // Check cache
//     const cacheKey = `contacts:${req.orgId}:tags`;
//     let tags = await cache.get<string[]>(cacheKey);

//     if (!tags) {
//       const contacts = await prisma.contact.findMany({
//         where: { orgId: req.orgId },
//         select: { tags: true },
//       });

//       const tagSet = new Set<string>();
//       contacts.forEach((c) => c.tags.forEach((t) => tagSet.add(t)));
//       tags = Array.from(tagSet).sort();

//       // Cache for 5 minutes
//       await cache.set(cacheKey, tags, 300);
//     }

//     res.json({
//       success: true,
//       data: tags,
//     });
//   })
// );

// export default router;